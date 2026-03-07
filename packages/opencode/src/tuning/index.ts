import { Log } from "@/util/log"
import { TuningRules } from "./rules"

/**
 * Adaptive session tuning — observes tool success patterns within
 * a session and dynamically adjusts tool preferences and approach.
 *
 * Injected as a `<tuning>` block in the system prompt when
 * adjustments are detected.
 */
export namespace Tuning {
  const log = Log.create({ service: "tuning" })

  /** Re-export types. */
  export type Adjustment = TuningRules.Adjustment
  export type ToolRecord = TuningRules.ToolRecord

  /** Per-session tool history. */
  const sessions = new Map<string, ToolRecord[]>()

  /** Per-session active adjustments. */
  const activeAdjustments = new Map<string, Adjustment[]>()

  /** Max history per session. */
  const MAX_HISTORY = 100

  /**
   * Record a tool result for analysis.
   *
   * @param sessionID - Session identifier
   * @param tool - Tool ID
   * @param success - Whether the tool call succeeded
   * @param operation - Optional operation within the tool
   */
  export function recordResult(
    sessionID: string,
    tool: string,
    success: boolean,
    operation?: string,
  ): void {
    let history = sessions.get(sessionID)
    if (!history) {
      history = []
      sessions.set(sessionID, history)
    }

    history.push({
      tool,
      operation,
      success,
      timestamp: Date.now(),
    })

    // Cap history
    if (history.length > MAX_HISTORY) {
      sessions.set(sessionID, history.slice(-MAX_HISTORY))
    }
  }

  /**
   * Analyze the session and detect needed adjustments.
   *
   * @param sessionID - Session identifier
   * @returns Current adjustments
   */
  export function analyze(sessionID: string): Adjustment[] {
    const history = sessions.get(sessionID) ?? []
    const adjustments = TuningRules.analyze(history)

    activeAdjustments.set(sessionID, adjustments)
    return adjustments
  }

  /**
   * Get current active adjustments for a session.
   *
   * @param sessionID - Session identifier
   * @returns Active adjustments
   */
  export function active(sessionID: string): Adjustment[] {
    return activeAdjustments.get(sessionID) ?? []
  }

  /**
   * Format adjustments for system prompt injection.
   *
   * Returns empty string if no adjustments are active.
   *
   * @param sessionID - Session identifier
   * @returns Formatted `<tuning>` block, or empty string
   */
  export function format(sessionID: string): string {
    const adjustments = analyze(sessionID)
    if (adjustments.length === 0) return ""

    const lines: string[] = ["<tuning>"]

    for (const adj of adjustments.slice(0, 5)) {
      lines.push(`  [${adj.type}] ${adj.reason}`)
      if (adj.suggestion) {
        lines.push(`    → ${adj.suggestion}`)
      }
    }

    lines.push("</tuning>")
    return lines.join("\n")
  }

  /**
   * Get history length for a session.
   *
   * @param sessionID - Session identifier
   * @returns Number of recorded tool uses
   */
  export function historyLength(sessionID: string): number {
    return (sessions.get(sessionID) ?? []).length
  }

  /**
   * Clear session state.
   *
   * @param sessionID - Session identifier
   */
  export function clear(sessionID: string): void {
    sessions.delete(sessionID)
    activeAdjustments.delete(sessionID)
  }

  /**
   * Clear all sessions.
   */
  export function clearAll(): void {
    sessions.clear()
    activeAdjustments.clear()
  }
}
