import { Device } from "./index"
import { EventJournal } from "../bus/journal"
import { Session } from "../session"
import { Log } from "../util/log"
import z from "zod"

const log = Log.create({ service: "device.sync" })

/**
 * Sync protocol for multi-device session sharing.
 *
 * Each device tracks its position in the event journal via `last_seen_seq`.
 * When a device syncs, it receives:
 * 1. All events since its last sync (delta)
 * 2. Optionally, a full session list snapshot
 *
 * The protocol is pull-based: devices poll `/sync` at their own cadence.
 * Push notifications (via DevicePush) tell devices *when* to poll.
 */
export namespace DeviceSync {
  // ── Schemas ──

  export const SyncRequest = z.object({
    deviceID: z.string(),
    /** If true, include full session list in response. */
    includeSessions: z.boolean().optional(),
    /** Override: fetch events after this seq instead of device's stored cursor. */
    afterSeq: z.number().optional(),
    /** Max events to return (default: 200, max: 500). */
    limit: z.number().optional(),
  })
  export type SyncRequest = z.infer<typeof SyncRequest>

  export const SyncResponse = z.object({
    /** Events since last sync. */
    events: z.array(
      z.object({
        seq: z.number(),
        type: z.string(),
        payload: z.any(),
        timeCreated: z.number(),
      }),
    ),
    /** Current latest sequence number. */
    latestSeq: z.number(),
    /** Number of events the device hasn't seen yet (including beyond limit). */
    pending: z.number(),
    /** Session summaries (only if includeSessions was true). */
    sessions: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          directory: z.string(),
          updated: z.number(),
        }),
      )
      .optional(),
    /** Server timestamp for reference. */
    serverTime: z.number(),
  })
  export type SyncResponse = z.infer<typeof SyncResponse>

  /**
   * Perform a sync for a device. Returns events since last sync
   * and optionally a session snapshot.
   */
  export function sync(input: SyncRequest): SyncResponse {
    const device = Device.get(input.deviceID)
    if (!device) {
      throw new Error(`Device ${input.deviceID} not found`)
    }

    const afterSeq = input.afterSeq ?? device.lastSeenSeq
    const limit = Math.min(input.limit ?? 200, 500)
    const latestSeq = EventJournal.latestSeq()

    // Get events since last sync
    const events = EventJournal.replay(afterSeq, limit)

    // Calculate pending (events beyond what we're returning)
    const lastReturnedSeq = events.length > 0 ? events[events.length - 1].seq : afterSeq
    const pending = latestSeq - lastReturnedSeq

    // Update device's sync cursor to the latest event we returned
    if (events.length > 0) {
      Device.recordSync(input.deviceID, lastReturnedSeq)
    }

    // Build session list if requested
    let sessions: SyncResponse["sessions"]
    if (input.includeSessions) {
      const allSessions = [...Session.list()]
      sessions = allSessions.map((s) => ({
        id: s.id,
        title: s.title,
        directory: s.directory,
        updated: s.time.updated,
      }))
    }

    log.info("device synced", {
      deviceID: input.deviceID,
      afterSeq,
      eventsReturned: events.length,
      pending,
    })

    return {
      events,
      latestSeq,
      pending,
      sessions,
      serverTime: Date.now(),
    }
  }
}
