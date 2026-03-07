import { Log } from "@/util/log"
import { SessionState } from "./state"
import { Scratchpad } from "@/scratchpad"
import { MessageV2 } from "./message-v2"

/**
 * Context resumption protocol — captures the agent's working context
 * before compaction and provides a structured resumption block after
 * compaction so the agent knows exactly where it left off.
 *
 * The snapshot is stored in memory (not in messages), so it survives
 * compaction. The format is compact enough to fit in ~500 tokens.
 */
export namespace Resumption {
  const log = Log.create({ service: "session.resumption" })

  /** Snapshot of working context captured before compaction. */
  export interface Snapshot {
    /** Session ID this snapshot belongs to. */
    sessionID: string
    /** Timestamp when snapshot was taken. */
    timestamp: number
    /** Current goal from session state. */
    goal: string
    /** Active plan step (if any). */
    activeStep?: string
    /** Plan progress summary. */
    planProgress?: string
    /** Working set files. */
    workingSet: string[]
    /** Recent decisions. */
    recentDecisions: string[]
    /** Last N scratchpad thoughts (condensed). */
    lastThoughts: string[]
    /** Files recently modified (from working context). */
    recentModifications: string[]
    /** Active verification errors (if any). */
    pendingErrors?: string
    /** Invariants from session state. */
    invariants: string[]
    /** Failed approaches to not retry. */
    failedApproaches: string[]
  }

  /** Per-session snapshots. */
  const snapshots = new Map<string, Snapshot>()

  /**
   * Capture a snapshot of the current working context.
   *
   * Call this before compaction to preserve context that would otherwise
   * be lost when tool outputs are cleared.
   *
   * @param sessionID - Session identifier
   * @param messages - Current conversation messages
   * @param extras - Optional additional context
   * @returns The captured snapshot
   */
  export function snapshot(
    sessionID: string,
    messages: MessageV2.WithParts[],
    extras?: {
      recentModifications?: string[]
      pendingErrors?: string
    },
  ): Snapshot {
    // Extract session state
    const state = SessionState.extract(messages)

    // Extract recent thoughts
    const thoughts = Scratchpad.getIndexedThoughts(sessionID) ?? Scratchpad.extractThoughts(messages)
    const lastThoughts = thoughts.slice(-3).map((t) => {
      // Condense to first 200 chars
      return t.length > 200 ? t.slice(0, 200) + "..." : t
    })

    // Extract plan progress
    let activeStep: string | undefined
    let planProgress: string | undefined
    if (state && state.plan.length > 0) {
      const active = state.plan.find((s) => s.status === "active")
      activeStep = active ? `[${active.id}] ${active.step}` : undefined

      const done = state.plan.filter((s) => s.status === "done").length
      const total = state.plan.length
      planProgress = `${done}/${total} steps completed`
    }

    // Extract recent decisions (last 3)
    const recentDecisions = (state?.decisions ?? [])
      .slice(-3)
      .map((d) => `${d.choice} (${d.reason})`)

    const snap: Snapshot = {
      sessionID,
      timestamp: Date.now(),
      goal: state?.goal ?? "",
      activeStep,
      planProgress,
      workingSet: state?.workingSet ?? [],
      recentDecisions,
      lastThoughts,
      recentModifications: extras?.recentModifications ?? [],
      pendingErrors: extras?.pendingErrors,
      invariants: state?.invariants ?? [],
      failedApproaches: (state?.failedApproaches ?? []).map((f) => `${f.approach}: ${f.reason}`),
    }

    snapshots.set(sessionID, snap)
    log.info("context snapshot captured", {
      sessionID,
      hasGoal: !!snap.goal,
      workingSetSize: snap.workingSet.length,
      thoughtCount: snap.lastThoughts.length,
    })

    return snap
  }

  /**
   * Check if a snapshot exists for a session.
   *
   * @param sessionID - Session identifier
   * @returns True if a snapshot exists
   */
  export function hasSnapshot(sessionID: string): boolean {
    return snapshots.has(sessionID)
  }

  /**
   * Get the snapshot for a session without consuming it.
   *
   * @param sessionID - Session identifier
   * @returns The snapshot, or undefined
   */
  export function get(sessionID: string): Snapshot | undefined {
    return snapshots.get(sessionID)
  }

  /**
   * Restore context after compaction — consume the snapshot and
   * return a formatted resumption block.
   *
   * The snapshot is consumed (deleted) after formatting so it's
   * only injected once.
   *
   * @param sessionID - Session identifier
   * @returns Formatted resumption block, or undefined if no snapshot
   */
  export function restore(sessionID: string): string | undefined {
    const snap = snapshots.get(sessionID)
    if (!snap) return undefined

    // Consume the snapshot
    snapshots.delete(sessionID)

    return format(snap)
  }

  /**
   * Format a snapshot into a resumption block for system prompt injection.
   *
   * @param snap - The snapshot to format
   * @returns Formatted `<resumption>` block
   */
  export function format(snap: Snapshot): string {
    const lines: string[] = []
    lines.push("<resumption>")
    lines.push("Context was compacted. Here is where you left off:")
    lines.push("")

    // Goal
    if (snap.goal) {
      lines.push(`Goal: ${snap.goal}`)
    }

    // Plan progress
    if (snap.planProgress) {
      lines.push(`Plan: ${snap.planProgress}`)
    }
    if (snap.activeStep) {
      lines.push(`Current step: ${snap.activeStep}`)
    }

    // Working set
    if (snap.workingSet.length > 0) {
      lines.push(`Working files: ${snap.workingSet.slice(0, 10).join(", ")}`)
    }

    // Recent modifications
    if (snap.recentModifications.length > 0) {
      lines.push(`Recently modified: ${snap.recentModifications.slice(0, 10).join(", ")}`)
    }

    // Decisions
    if (snap.recentDecisions.length > 0) {
      lines.push("")
      lines.push("Recent decisions:")
      for (const d of snap.recentDecisions) {
        lines.push(`  - ${d}`)
      }
    }

    // Invariants
    if (snap.invariants.length > 0) {
      lines.push("")
      lines.push("Invariants:")
      for (const inv of snap.invariants) {
        lines.push(`  - ${inv}`)
      }
    }

    // Failed approaches
    if (snap.failedApproaches.length > 0) {
      lines.push("")
      lines.push("Do NOT retry these approaches:")
      for (const fa of snap.failedApproaches) {
        lines.push(`  - ${fa}`)
      }
    }

    // Last thoughts
    if (snap.lastThoughts.length > 0) {
      lines.push("")
      lines.push("Your last thoughts:")
      for (const t of snap.lastThoughts) {
        lines.push(`  "${t}"`)
      }
    }

    // Pending errors
    if (snap.pendingErrors) {
      lines.push("")
      lines.push(`Pending verification errors: ${snap.pendingErrors}`)
    }

    lines.push("</resumption>")
    return lines.join("\n")
  }

  /**
   * Clear snapshot for a session.
   *
   * @param sessionID - Session identifier
   */
  export function clear(sessionID: string): void {
    snapshots.delete(sessionID)
  }

  /**
   * Clear all snapshots.
   */
  export function clearAll(): void {
    snapshots.clear()
  }
}
