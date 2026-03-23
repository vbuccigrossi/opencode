import z from "zod"
import { Cron } from "croner"
import { eq, and, lte } from "drizzle-orm"
import { Identifier } from "../id/id"
import { Database } from "../storage/db"
import { ScheduledTaskTable } from "./schedule.sql"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util/log"
import { Instance } from "../project/instance"

const log = Log.create({ service: "schedule" })

/** Branded ID type for scheduled tasks. */
export type ScheduledTaskID = string & { readonly __brand: "ScheduledTaskID" }

export namespace Schedule {
  // ── Schemas ──

  export const DeliveryConfig = z.discriminatedUnion("type", [
    z.object({ type: z.literal("session") }),
    z.object({ type: z.literal("file"), path: z.string() }),
    z.object({
      type: z.literal("webhook"),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ])
  export type DeliveryConfig = z.infer<typeof DeliveryConfig>

  export const Info = z.object({
    id: z.string(),
    projectID: z.string(),
    name: z.string(),
    cron: z.string(),
    prompt: z.string(),
    directory: z.string(),
    agent: z.string().optional(),
    model: z.string().optional(),
    delivery: DeliveryConfig.default({ type: "session" }),
    enabled: z.boolean(),
    lastRunAt: z.number().optional(),
    lastStatus: z.enum(["success", "error"]).optional(),
    lastError: z.string().optional(),
    lastSessionID: z.string().optional(),
    nextRunAt: z.number().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    name: z.string().min(1),
    cron: z.string().min(1),
    prompt: z.string().min(1),
    directory: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    delivery: DeliveryConfig.optional(),
  })
  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    id: z.string(),
    name: z.string().optional(),
    cron: z.string().optional(),
    prompt: z.string().optional(),
    agent: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    delivery: DeliveryConfig.optional(),
    enabled: z.boolean().optional(),
  })
  export type UpdateInput = z.infer<typeof UpdateInput>

  // ── Events ──

  export const Event = {
    Created: BusEvent.define("schedule.created", z.object({ info: Info })),
    Updated: BusEvent.define("schedule.updated", z.object({ info: Info })),
    Deleted: BusEvent.define("schedule.deleted", z.object({ id: z.string() })),
    Executed: BusEvent.define(
      "schedule.executed",
      z.object({ id: z.string(), sessionID: z.string(), status: z.enum(["success", "error"]) }),
    ),
  }

  // ── Helpers ──

  /** Compute the next fire time for a cron expression. */
  export function nextRun(cronExpr: string, after?: Date): number | undefined {
    try {
      const job = new Cron(cronExpr)
      const next = job.nextRun(after)
      return next ? next.getTime() : undefined
    } catch {
      return undefined
    }
  }

  /** Validate a cron expression. Returns error message or undefined if valid. */
  export function validateCron(cronExpr: string): string | undefined {
    try {
      new Cron(cronExpr)
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : "Invalid cron expression"
    }
  }

  /** Convert a cron expression to a human-readable description. */
  export function describeCron(cronExpr: string): string {
    try {
      const job = new Cron(cronExpr)
      const next = job.nextRun()
      if (!next) return cronExpr
      return `next: ${next.toLocaleString()}`
    } catch {
      return cronExpr
    }
  }

  function toInfo(row: typeof ScheduledTaskTable.$inferSelect): Info {
    return {
      id: row.id,
      projectID: row.project_id,
      name: row.name,
      cron: row.cron,
      prompt: row.prompt,
      directory: row.directory,
      agent: row.agent ?? undefined,
      model: row.model ?? undefined,
      delivery: (row.delivery as DeliveryConfig) ?? { type: "session" },
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
      lastSessionID: row.last_session_id ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  // ── CRUD ──

  export function create(input: CreateInput): Info {
    const cronErr = validateCron(input.cron)
    if (cronErr) throw new Error(`Invalid cron: ${cronErr}`)

    const now = Date.now()
    const id = Identifier.descending("schedule") as ScheduledTaskID
    const directory = input.directory ?? Instance.directory
    const next = nextRun(input.cron)

    const row = {
      id,
      project_id: Instance.project.id,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      directory,
      agent: input.agent ?? null,
      model: input.model ?? null,
      delivery: input.delivery ?? { type: "session" as const },
      enabled: 1,
      next_run_at: next ?? null,
      time_created: now,
      time_updated: now,
    }

    Database.use((db) => {
      db.insert(ScheduledTaskTable).values(row).run()
    })

    const info = toInfo({ ...row, last_run_at: null, last_status: null, last_error: null, last_session_id: null })
    log.info("created scheduled task", { id, name: input.name, cron: input.cron })
    Bus.publish(Event.Created, { info })
    return info
  }

  export function update(input: UpdateInput): Info {
    if (input.cron) {
      const cronErr = validateCron(input.cron)
      if (cronErr) throw new Error(`Invalid cron: ${cronErr}`)
    }

    const now = Date.now()
    const updates: Record<string, unknown> = { time_updated: now }

    if (input.name !== undefined) updates.name = input.name
    if (input.cron !== undefined) {
      updates.cron = input.cron
      updates.next_run_at = nextRun(input.cron) ?? null
    }
    if (input.prompt !== undefined) updates.prompt = input.prompt
    if (input.agent !== undefined) updates.agent = input.agent
    if (input.model !== undefined) updates.model = input.model
    if (input.delivery !== undefined) updates.delivery = input.delivery
    if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0

    Database.use((db) => {
      db.update(ScheduledTaskTable).set(updates).where(eq(ScheduledTaskTable.id, input.id as ScheduledTaskID)).run()
    })

    const info = get(input.id)
    if (info) {
      log.info("updated scheduled task", { id: input.id })
      Bus.publish(Event.Updated, { info })
    }
    return info!
  }

  export function remove(id: string): void {
    Database.use((db) => {
      db.delete(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id as ScheduledTaskID)).run()
    })
    log.info("deleted scheduled task", { id })
    Bus.publish(Event.Deleted, { id })
  }

  export function get(id: string): Info | undefined {
    const row = Database.use((db) =>
      db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id as ScheduledTaskID)).get(),
    )
    return row ? toInfo(row) : undefined
  }

  export function list(projectID?: string): Info[] {
    return Database.use((db) => {
      const query = projectID
        ? db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.project_id, projectID))
        : db.select().from(ScheduledTaskTable)
      return query.all().map(toInfo)
    })
  }

  /** Query tasks that are due to run (enabled + next_run_at <= now). */
  export function due(): Info[] {
    const now = Date.now()
    return Database.use((db) =>
      db
        .select()
        .from(ScheduledTaskTable)
        .where(and(eq(ScheduledTaskTable.enabled, 1), lte(ScheduledTaskTable.next_run_at, now)))
        .all()
        .map(toInfo),
    )
  }

  /** Record the result of an execution and compute the next run time. */
  export function recordExecution(
    id: string,
    result: { status: "success" | "error"; sessionID?: string; error?: string },
  ): void {
    const task = get(id)
    if (!task) return

    const now = Date.now()
    const next = nextRun(task.cron, new Date(now))

    Database.use((db) => {
      db.update(ScheduledTaskTable)
        .set({
          last_run_at: now,
          last_status: result.status,
          last_error: result.error ?? null,
          last_session_id: (result.sessionID ?? null) as any,
          next_run_at: next ?? null,
          time_updated: now,
        })
        .where(eq(ScheduledTaskTable.id, id as ScheduledTaskID))
        .run()
    })

    Bus.publish(Event.Executed, {
      id,
      sessionID: result.sessionID ?? "",
      status: result.status,
    })
  }
}
