import { gt, desc, gte, lte } from "drizzle-orm"
import { Database } from "../storage/db"
import { EventJournalTable } from "./journal.sql"
import { Bus } from "./index"
import { Log } from "../util/log"

const log = Log.create({ service: "bus.journal" })

/**
 * Event journal — persists Bus events to SQLite with auto-incrementing
 * sequence numbers. Enables SSE clients to catch up after disconnect
 * by replaying events from a given sequence number.
 *
 * Events are recorded via Bus.subscribeAll(). The journal is append-only;
 * old entries are pruned periodically to prevent unbounded growth.
 */
export namespace EventJournal {
  /** Maximum number of events to retain. Older events are pruned. */
  const MAX_EVENTS = 10_000
  /** How often to prune (in number of inserts). */
  const PRUNE_INTERVAL = 500

  let insertCount = 0
  let unsub: (() => void) | undefined

  export interface Entry {
    seq: number
    type: string
    payload: unknown
    timeCreated: number
  }

  /** Ensure the event_journal table exists (idempotent). */
  function ensureTable(): void {
    Database.use((db) => {
      db.run(/*sql*/ `CREATE TABLE IF NOT EXISTS event_journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        time_created INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )`)
      db.run(/*sql*/ `CREATE INDEX IF NOT EXISTS event_journal_type_idx ON event_journal (type)`)
      db.run(/*sql*/ `CREATE INDEX IF NOT EXISTS event_journal_time_idx ON event_journal (time_created)`)
    })
  }

  /** Start recording Bus events to the journal. Safe to call multiple times — only starts once. */
  export function start(): void {
    if (unsub) return

    // Ensure the table exists before subscribing
    try {
      ensureTable()
    } catch {
      // If DB isn't ready yet (no Instance context), defer to next call
      return
    }

    unsub = Bus.subscribeAll((event) => {
      // Skip heartbeats and internal events from the journal
      if (event.type === "server.heartbeat" || event.type === "server.connected") return

      try {
        Database.use((db) => {
          db.insert(EventJournalTable)
            .values({
              type: event.type,
              payload: JSON.stringify(event),
              time_created: Date.now(),
            })
            .run()
        })

        insertCount++
        if (insertCount % PRUNE_INTERVAL === 0) {
          prune()
        }
      } catch (err) {
        log.error("journal write failed", { type: event.type, error: err })
      }
    })

    log.info("event journal started")
  }

  /** Stop recording events. */
  export function stop(): void {
    if (!unsub) return
    unsub()
    unsub = undefined
    log.info("event journal stopped")
  }

  /**
   * Replay events after a given sequence number.
   * Returns events with seq > afterSeq, up to limit.
   */
  export function replay(afterSeq: number, limit = 200): Entry[] {
    return Database.use((db) =>
      db
        .select()
        .from(EventJournalTable)
        .where(gt(EventJournalTable.seq, afterSeq))
        .orderBy(EventJournalTable.seq)
        .limit(limit)
        .all()
        .map((row) => ({
          seq: row.seq!,
          type: row.type,
          payload: JSON.parse(row.payload),
          timeCreated: row.time_created,
        })),
    )
  }

  /**
   * Get events since a timestamp (for initial sync when client has no seq).
   */
  export function since(timestampMs: number, limit = 200): Entry[] {
    return Database.use((db) =>
      db
        .select()
        .from(EventJournalTable)
        .where(gte(EventJournalTable.time_created, timestampMs))
        .orderBy(EventJournalTable.seq)
        .limit(limit)
        .all()
        .map((row) => ({
          seq: row.seq!,
          type: row.type,
          payload: JSON.parse(row.payload),
          timeCreated: row.time_created,
        })),
    )
  }

  /** Get the latest sequence number. */
  export function latestSeq(): number {
    const row = Database.use((db) =>
      db
        .select({ seq: EventJournalTable.seq })
        .from(EventJournalTable)
        .orderBy(desc(EventJournalTable.seq))
        .limit(1)
        .get(),
    )
    return row?.seq ?? 0
  }

  /** Prune old events beyond MAX_EVENTS. */
  function prune(): void {
    try {
      // Find the seq of the event at the MAX_EVENTS boundary
      const cutoff = Database.use((db) => {
        const row = db
          .select({ seq: EventJournalTable.seq })
          .from(EventJournalTable)
          .orderBy(desc(EventJournalTable.seq))
          .limit(1)
          .offset(MAX_EVENTS)
          .get()
        return row?.seq
      })

      if (cutoff !== undefined && cutoff !== null) {
        Database.use((db) => {
          db.delete(EventJournalTable).where(lte(EventJournalTable.seq, cutoff)).run()
        })
        log.info("journal pruned", { cutoffSeq: cutoff })
      }
    } catch (err) {
      log.error("journal prune failed", { error: err })
    }
  }
}
