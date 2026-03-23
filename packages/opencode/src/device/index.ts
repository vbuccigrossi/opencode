import { randomBytes } from "crypto"
import { eq } from "drizzle-orm"
import z from "zod"
import { Database } from "../storage/db"
import { DeviceTable } from "./device.sql"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util/log"

const log = Log.create({ service: "device" })

/** Branded ID type for devices. */
export type DeviceID = string & { readonly __brand: "DeviceID" }

export namespace Device {
  // ── Schemas ──

  export const Info = z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    pushUrl: z.string().optional(),
    pushHeaders: z.record(z.string(), z.string()).optional(),
    pushEvents: z.array(z.string()),
    lastSeenSeq: z.number(),
    lastSyncAt: z.number().optional(),
    capabilities: z.array(z.string()),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type Info = z.infer<typeof Info>

  export const RegisterInput = z.object({
    name: z.string().min(1),
    type: z.string().optional(),
    pushUrl: z.string().optional(),
    pushHeaders: z.record(z.string(), z.string()).optional(),
    pushEvents: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
  })
  export type RegisterInput = z.infer<typeof RegisterInput>

  export const UpdateInput = z.object({
    id: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    pushUrl: z.string().nullable().optional(),
    pushHeaders: z.record(z.string(), z.string()).nullable().optional(),
    pushEvents: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
  })
  export type UpdateInput = z.infer<typeof UpdateInput>

  // ── Events ──

  export const Event = {
    Registered: BusEvent.define("device.registered", z.object({ info: Info })),
    Updated: BusEvent.define("device.updated", z.object({ info: Info })),
    Removed: BusEvent.define("device.removed", z.object({ id: z.string() })),
    Synced: BusEvent.define("device.synced", z.object({ id: z.string(), seq: z.number() })),
  }

  // ── Table creation ──

  let tableReady = false
  function ensureReady(): void {
    if (tableReady) return
    Database.use((db) => {
      db.run(/*sql*/ `CREATE TABLE IF NOT EXISTS device (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'unknown',
        push_url TEXT,
        push_headers TEXT,
        push_events TEXT NOT NULL DEFAULT '["*"]',
        last_seen_seq INTEGER NOT NULL DEFAULT 0,
        last_sync_at INTEGER,
        capabilities TEXT NOT NULL DEFAULT '[]',
        time_created INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        time_updated INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )`)
      db.run(/*sql*/ `CREATE INDEX IF NOT EXISTS device_name_idx ON device (name)`)
    })
    tableReady = true
  }

  // ── Helpers ──

  function toInfo(row: typeof DeviceTable.$inferSelect): Info {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      pushUrl: row.push_url ?? undefined,
      pushHeaders: row.push_headers ? JSON.parse(row.push_headers) : undefined,
      pushEvents: JSON.parse(row.push_events),
      lastSeenSeq: row.last_seen_seq,
      lastSyncAt: row.last_sync_at ?? undefined,
      capabilities: JSON.parse(row.capabilities),
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  // ── CRUD ──

  /** Register a new device. Returns the device info and an API token for it. */
  export function register(input: RegisterInput): Info {
    ensureReady()
    const now = Date.now()
    const id = `dev_${randomBytes(8).toString("hex")}` as DeviceID

    const row = {
      id,
      name: input.name,
      type: input.type ?? "unknown",
      push_url: input.pushUrl ?? null,
      push_headers: input.pushHeaders ? JSON.stringify(input.pushHeaders) : null,
      push_events: JSON.stringify(input.pushEvents ?? ["*"]),
      last_seen_seq: 0,
      last_sync_at: null,
      capabilities: JSON.stringify(input.capabilities ?? []),
      time_created: now,
      time_updated: now,
    }

    Database.use((db) => {
      db.insert(DeviceTable).values(row).run()
    })

    const info = toInfo(row)
    log.info("device registered", { id, name: input.name, type: info.type })
    Bus.publish(Event.Registered, { info })
    return info
  }

  /** Update a device's settings. */
  export function update(input: UpdateInput): Info {
    ensureReady()
    const now = Date.now()
    const updates: Record<string, unknown> = { time_updated: now }

    if (input.name !== undefined) updates.name = input.name
    if (input.type !== undefined) updates.type = input.type
    if (input.pushUrl !== undefined) updates.push_url = input.pushUrl
    if (input.pushHeaders !== undefined) {
      updates.push_headers = input.pushHeaders ? JSON.stringify(input.pushHeaders) : null
    }
    if (input.pushEvents !== undefined) updates.push_events = JSON.stringify(input.pushEvents)
    if (input.capabilities !== undefined) updates.capabilities = JSON.stringify(input.capabilities)

    Database.use((db) => {
      db.update(DeviceTable).set(updates).where(eq(DeviceTable.id, input.id as DeviceID)).run()
    })

    const info = get(input.id)
    if (info) {
      log.info("device updated", { id: input.id })
      Bus.publish(Event.Updated, { info })
    }
    return info!
  }

  /** Remove a device. */
  export function remove(id: string): void {
    ensureReady()
    Database.use((db) => {
      db.delete(DeviceTable).where(eq(DeviceTable.id, id as DeviceID)).run()
    })
    log.info("device removed", { id })
    Bus.publish(Event.Removed, { id })
  }

  /** Get a device by ID. */
  export function get(id: string): Info | undefined {
    ensureReady()
    const row = Database.use((db) =>
      db.select().from(DeviceTable).where(eq(DeviceTable.id, id as DeviceID)).get(),
    )
    return row ? toInfo(row) : undefined
  }

  /** List all registered devices. */
  export function list(): Info[] {
    ensureReady()
    return Database.use((db) => db.select().from(DeviceTable).all().map(toInfo))
  }

  /**
   * Record that a device has synced up to a given event journal sequence number.
   * This enables efficient delta sync — next time, only events after this seq are sent.
   */
  export function recordSync(id: string, seq: number): void {
    ensureReady()
    const now = Date.now()
    Database.use((db) => {
      db.update(DeviceTable)
        .set({ last_seen_seq: seq, last_sync_at: now, time_updated: now })
        .where(eq(DeviceTable.id, id as DeviceID))
        .run()
    })
    Bus.publish(Event.Synced, { id, seq })
  }

  /**
   * Get devices that should receive push notifications for a given event type.
   * Returns devices with push_url configured whose push_events filter matches.
   */
  export function getPushTargets(eventType: string): Info[] {
    ensureReady()
    const all = list()
    return all.filter((d) => {
      if (!d.pushUrl) return false
      if (d.pushEvents.includes("*")) return true
      return d.pushEvents.includes(eventType)
    })
  }
}
