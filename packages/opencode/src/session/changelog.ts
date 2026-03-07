import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { File } from "../file"
import path from "path"

/**
 * Tracks all file changes made during a session.
 *
 * Records each edit/write/patch with metadata so the agent can query
 * what changed, when, and by which tool. Used by the diff and undo tools
 * to provide structured change history.
 */
export namespace Changelog {
  const log = Log.create({ service: "session.changelog" })

  /** A single recorded change to a file. */
  export interface Entry {
    /** Unique entry ID (monotonic counter) */
    id: number
    /** Timestamp of the change */
    timestamp: number
    /** Absolute file path */
    file: string
    /** Operation type */
    operation: "edit" | "write" | "create" | "delete" | "patch" | "external"
    /** Tool that made the change */
    toolID?: string
    /** Message that triggered the change */
    messageID?: string
    /** Session this change belongs to */
    sessionID?: string
    /** Snapshot hash before the change (if available) */
    snapshotBefore?: string
    /** Snapshot hash after the change (if available) */
    snapshotAfter?: string
    /** Lines added */
    additions: number
    /** Lines removed */
    deletions: number
    /** Short description of what changed */
    summary?: string
  }

  let counter = 0
  const entries: Entry[] = []

  const state = Instance.state(
    () => {
      counter = 0
      entries.length = 0
      return { initialized: true }
    },
    async () => {
      entries.length = 0
      counter = 0
    },
  )

  /** Initialize the changelog and subscribe to file edit events. */
  export function init() {
    state()
    Bus.subscribe(File.Event.Edited, (event) => {
      const filePath = event.properties.file
      // Only record external edits — tool edits are recorded explicitly via record()
      // Check if a recent entry (within 500ms) already covers this file
      const now = Date.now()
      const recent = entries.find(
        (e) => e.file === filePath && now - e.timestamp < 500,
      )
      if (!recent) {
        record({
          file: filePath,
          operation: "external",
          additions: 0,
          deletions: 0,
          summary: "External file change detected",
        })
      }
    })
  }

  /**
   * Record a file change in the changelog.
   *
   * @param input - Change metadata (file, operation, additions, deletions, etc.)
   * @returns The created changelog entry
   */
  export function record(input: {
    file: string
    operation: Entry["operation"]
    toolID?: string
    messageID?: string
    sessionID?: string
    snapshotBefore?: string
    snapshotAfter?: string
    additions?: number
    deletions?: number
    summary?: string
  }): Entry {
    const entry: Entry = {
      id: ++counter,
      timestamp: Date.now(),
      file: input.file,
      operation: input.operation,
      toolID: input.toolID,
      messageID: input.messageID,
      sessionID: input.sessionID,
      snapshotBefore: input.snapshotBefore,
      snapshotAfter: input.snapshotAfter,
      additions: input.additions ?? 0,
      deletions: input.deletions ?? 0,
      summary: input.summary,
    }
    entries.push(entry)
    log.info("recorded", {
      id: entry.id,
      file: path.basename(entry.file),
      operation: entry.operation,
    })
    return entry
  }

  /** Get all changelog entries for a specific file, ordered by time. */
  export function forFile(file: string): Entry[] {
    const normalized = path.resolve(file)
    return entries.filter(
      (e) => path.resolve(e.file) === normalized,
    )
  }

  /** Get all changelog entries for a session, ordered by time. */
  export function forSession(sessionID: string): Entry[] {
    return entries.filter((e) => e.sessionID === sessionID)
  }

  /** Get all changelog entries, ordered by time. */
  export function all(): Entry[] {
    return [...entries]
  }

  /**
   * Get all files that have been modified.
   *
   * @returns Deduplicated list of absolute file paths
   */
  export function affectedFiles(): string[] {
    const files = new Set<string>()
    for (const entry of entries) {
      files.add(entry.file)
    }
    return [...files]
  }

  /**
   * Get files changed since a specific changelog entry ID.
   *
   * @param sinceID - Entry ID to look after
   * @returns Deduplicated list of absolute file paths changed since that entry
   */
  export function affectedFilesSince(sinceID: number): string[] {
    const files = new Set<string>()
    for (const entry of entries) {
      if (entry.id > sinceID) {
        files.add(entry.file)
      }
    }
    return [...files]
  }

  /**
   * Get the last changelog entry for a specific file.
   *
   * @param file - Absolute file path
   * @returns The most recent entry, or undefined
   */
  export function lastForFile(file: string): Entry | undefined {
    const normalized = path.resolve(file)
    for (let i = entries.length - 1; i >= 0; i--) {
      if (path.resolve(entries[i].file) === normalized) {
        return entries[i]
      }
    }
    return undefined
  }

  /**
   * Get a compact summary of all changes.
   *
   * @returns Object with file count, total additions, total deletions
   */
  export function summarize(): {
    files: number
    additions: number
    deletions: number
    operations: Record<string, number>
  } {
    const files = new Set<string>()
    let additions = 0
    let deletions = 0
    const operations: Record<string, number> = {}
    for (const entry of entries) {
      files.add(entry.file)
      additions += entry.additions
      deletions += entry.deletions
      operations[entry.operation] = (operations[entry.operation] ?? 0) + 1
    }
    return {
      files: files.size,
      additions,
      deletions,
      operations,
    }
  }

  /** Clear all entries (for testing). */
  export function clear() {
    entries.length = 0
    counter = 0
  }
}
