import { Log } from "@/util/log"

/**
 * Tuning rules — heuristic patterns that detect when the current
 * approach isn't working and suggest adjustments.
 */
export namespace TuningRules {
  const log = Log.create({ service: "tuning.rules" })

  /** Types of adjustments the tuner can suggest. */
  export type AdjustmentType =
    | "prefer_tool"
    | "avoid_tool"
    | "think_more"
    | "switch_strategy"
    | "slow_down"
    | "try_alternative"

  /** A suggested adjustment. */
  export interface Adjustment {
    type: AdjustmentType
    reason: string
    tool?: string
    suggestion?: string
    priority: number // 0-1, higher = more urgent
  }

  /** Session history record for tuning analysis. */
  export interface ToolRecord {
    tool: string
    operation?: string
    success: boolean
    timestamp: number
  }

  /**
   * Analyze recent tool history and produce adjustments.
   *
   * @param history - Recent tool use records
   * @returns Array of suggested adjustments
   */
  export function analyze(history: ToolRecord[]): Adjustment[] {
    const adjustments: Adjustment[] = []

    adjustments.push(...detectSearchPivot(history))
    adjustments.push(...detectVerificationSpiral(history))
    adjustments.push(...detectReadFatigue(history))
    adjustments.push(...detectRepeatedFailure(history))
    adjustments.push(...detectToolPreference(history))

    // Sort by priority
    adjustments.sort((a, b) => b.priority - a.priority)

    return adjustments
  }

  // ─── Rule Implementations ─────────────────────────────────────

  /**
   * Search pivot: 3+ failed greps → suggest graph or explore tool.
   */
  function detectSearchPivot(history: ToolRecord[]): Adjustment[] {
    const recent = history.slice(-10)
    const failedGreps = recent.filter(
      (r) => r.tool === "grep" && !r.success,
    )

    if (failedGreps.length >= 3) {
      return [{
        type: "try_alternative",
        reason: `grep failed ${failedGreps.length} times recently`,
        tool: "grep",
        suggestion: "Try the graph tool (callers/callees) or explore tool (parallel search) instead of grep",
        priority: 0.8,
      }]
    }

    return []
  }

  /**
   * Verification spiral: 3+ consecutive verify failures → think first.
   */
  function detectVerificationSpiral(history: ToolRecord[]): Adjustment[] {
    const recent = history.slice(-8)
    let consecutiveFails = 0

    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].tool === "verify" && !recent[i].success) {
        consecutiveFails++
      } else if (recent[i].tool === "verify") {
        break
      }
    }

    if (consecutiveFails >= 3) {
      return [{
        type: "think_more",
        reason: `${consecutiveFails} consecutive verification failures`,
        suggestion: "Stop and think about the root cause before making more edits. Consider reading the error messages carefully and checking your assumptions.",
        priority: 0.9,
      }]
    }

    return []
  }

  /**
   * Read fatigue: 5+ reads without an edit → over-researching.
   */
  function detectReadFatigue(history: ToolRecord[]): Adjustment[] {
    const recent = history.slice(-10)
    let readsWithoutEdit = 0

    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].tool === "read" || recent[i].tool === "grep" || recent[i].tool === "glob") {
        readsWithoutEdit++
      } else if (recent[i].tool === "edit" || recent[i].tool === "write") {
        break
      }
    }

    if (readsWithoutEdit >= 5) {
      return [{
        type: "slow_down",
        reason: `${readsWithoutEdit} research operations without making an edit`,
        suggestion: "You may be over-researching. Consider making a targeted edit based on what you've learned, or use the explore tool to batch your remaining research.",
        priority: 0.6,
      }]
    }

    return []
  }

  /**
   * Repeated failure: same tool failing repeatedly.
   */
  function detectRepeatedFailure(history: ToolRecord[]): Adjustment[] {
    const recent = history.slice(-10)
    const failCounts = new Map<string, number>()

    for (const r of recent) {
      if (!r.success) {
        failCounts.set(r.tool, (failCounts.get(r.tool) ?? 0) + 1)
      }
    }

    const adjustments: Adjustment[] = []
    for (const [tool, count] of failCounts) {
      if (count >= 3) {
        adjustments.push({
          type: "avoid_tool",
          reason: `${tool} has failed ${count} times in recent history`,
          tool,
          suggestion: `Consider using an alternative to ${tool}, or check if your inputs are correct.`,
          priority: 0.7,
        })
      }
    }

    return adjustments
  }

  /**
   * Tool preference: if one tool consistently outperforms another.
   */
  function detectToolPreference(history: ToolRecord[]): Adjustment[] {
    if (history.length < 10) return []

    const toolStats = new Map<string, { success: number; total: number }>()

    for (const r of history) {
      const stat = toolStats.get(r.tool) ?? { success: 0, total: 0 }
      stat.total++
      if (r.success) stat.success++
      toolStats.set(r.tool, stat)
    }

    const adjustments: Adjustment[] = []

    // Find tools with very low success rates
    for (const [tool, stat] of toolStats) {
      if (stat.total >= 5 && stat.success / stat.total < 0.3) {
        adjustments.push({
          type: "avoid_tool",
          reason: `${tool} has only ${Math.round((stat.success / stat.total) * 100)}% success rate (${stat.total} uses)`,
          tool,
          priority: 0.5,
        })
      }
    }

    return adjustments
  }
}
