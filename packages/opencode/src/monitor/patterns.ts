import { MonitorSignals } from "./signals"

/**
 * Pattern detection heuristics for the meta-cognitive monitor.
 *
 * Pure functions that analyze accumulated tool call history to detect
 * problematic patterns. No LLM calls — all pattern matching is
 * heuristic-based for sub-millisecond performance.
 */
export namespace MonitorPatterns {
  /**
   * Detects circular edit patterns — the agent editing the same file
   * multiple times without making progress.
   *
   * @param editCounts - Map of file path → edit count
   * @param threshold - Number of edits to trigger warning
   * @returns Warnings for files edited too many times
   */
  export function detectCircularEdits(
    editCounts: Map<string, number>,
    threshold: number,
  ): MonitorSignals.Warning[] {
    const warnings: MonitorSignals.Warning[] = []

    for (const [file, count] of editCounts) {
      if (count >= threshold) {
        const basename = file.split("/").pop() ?? file
        warnings.push({
          signal: "circular_edits",
          severity: count >= threshold + 2 ? "critical" : "warn",
          message: `${basename} edited ${count} times — step back and reconsider your approach`,
        })
      }
    }

    return warnings
  }

  /**
   * Detects redundant file reads — reading the same file repeatedly
   * when the content hasn't changed.
   *
   * @param readCounts - Map of file path → read count
   * @param editedFiles - Set of files that have been edited (re-reads after edits are OK)
   * @param threshold - Number of reads to trigger warning
   * @returns Warnings for files read too many times
   */
  export function detectRedundantReads(
    readCounts: Map<string, number>,
    editedFiles: Set<string>,
    threshold: number,
  ): MonitorSignals.Warning[] {
    const warnings: MonitorSignals.Warning[] = []

    for (const [file, count] of readCounts) {
      // Re-reading an edited file is expected
      if (editedFiles.has(file)) continue

      if (count >= threshold) {
        const basename = file.split("/").pop() ?? file
        warnings.push({
          signal: "redundant_reads",
          severity: "info",
          message: `${basename} read ${count} times without changes — content is already in context`,
        })
      }
    }

    return warnings
  }

  /**
   * Detects verification failure spirals — consecutive failures
   * suggesting the current approach isn't working.
   *
   * @param consecutiveFailures - Number of consecutive verification failures
   * @param threshold - Number of failures to trigger warning
   * @param checkpoint - Last known checkpoint (if any)
   * @returns Warning if in a verification spiral
   */
  export function detectVerificationSpiral(
    consecutiveFailures: number,
    threshold: number,
    checkpoint?: string,
  ): MonitorSignals.Warning | undefined {
    if (consecutiveFailures < threshold) return undefined

    const rollbackHint = checkpoint
      ? ` Checkpoint available: ${checkpoint} — consider rolling back.`
      : ""

    return {
      signal: "verification_spiral",
      severity: consecutiveFailures >= threshold + 2 ? "critical" : "warn",
      message: `Verification failed ${consecutiveFailures} consecutive times.${rollbackHint} Try a different approach.`,
    }
  }

  /**
   * Detects excessive context consumption — the agent burning through
   * its context window too quickly.
   *
   * @param usageRatio - Current context usage as a fraction (0-1)
   * @param step - Current step number
   * @param warnThreshold - Usage ratio to trigger warning
   * @param criticalThreshold - Usage ratio to trigger critical warning
   * @returns Warning if context is being consumed too fast
   */
  export function detectContextBurn(
    usageRatio: number,
    step: number,
    warnThreshold: number,
    criticalThreshold: number,
  ): MonitorSignals.Warning | undefined {
    if (usageRatio >= criticalThreshold) {
      const pct = Math.round(usageRatio * 100)
      return {
        signal: "context_burn",
        severity: "critical",
        message: `${pct}% of context used by step ${step} — be extremely concise, avoid unnecessary reads`,
      }
    }

    // Only warn about early burn rate (>50% by step 5 is suspicious)
    if (usageRatio >= warnThreshold && step <= 8) {
      const pct = Math.round(usageRatio * 100)
      return {
        signal: "context_burn",
        severity: "warn",
        message: `${pct}% of context used by step ${step} — be more targeted and concise`,
      }
    }

    return undefined
  }

  /**
   * Detects goal drift — the agent's recent actions not aligning
   * with its stated goal.
   *
   * Uses a simple heuristic: if the last N tool calls don't reference
   * any files from the working set or any keywords from the goal,
   * the agent may be drifting.
   *
   * @param recentTools - Last N tool names + file paths
   * @param goalKeywords - Keywords extracted from the goal
   * @param workingFiles - Files in the current working set
   * @param threshold - Number of unrelated steps before warning
   * @param goal - The full goal text for display
   * @returns Warning if goal drift detected
   */
  export function detectGoalDrift(
    recentTools: Array<{ tool: string; files: string[] }>,
    goalKeywords: string[],
    workingFiles: Set<string>,
    threshold: number,
    goal: string,
  ): MonitorSignals.Warning | undefined {
    if (recentTools.length < threshold) return undefined
    if (goalKeywords.length === 0) return undefined

    // Check last `threshold` tool calls for relevance
    const recent = recentTools.slice(-threshold)
    let unrelatedCount = 0

    for (const call of recent) {
      const isRelatedByFile = call.files.some((f) => workingFiles.has(f))
      const isRelatedByKeyword = goalKeywords.some((kw) =>
        call.files.some((f) => f.toLowerCase().includes(kw)) ||
        call.tool.toLowerCase().includes(kw),
      )

      if (!isRelatedByFile && !isRelatedByKeyword) {
        unrelatedCount++
      }
    }

    if (unrelatedCount >= threshold) {
      const truncatedGoal = goal.length > 60 ? goal.slice(0, 57) + "..." : goal
      return {
        signal: "goal_drift",
        severity: "warn",
        message: `Recent actions don't relate to your goal: "${truncatedGoal}" — are you on track?`,
      }
    }

    return undefined
  }

  /**
   * Detects unproductive reads — files that were read but never
   * referenced in any subsequent edit.
   *
   * @param readFiles - Files that have been read
   * @param editedFiles - Files that have been edited
   * @param referencedInEdits - Files referenced in edit tool calls (e.g., imported files)
   * @param threshold - Number of unproductive reads before warning
   * @returns Warning if too many unproductive reads
   */
  export function detectUnproductiveReads(
    readFiles: Set<string>,
    editedFiles: Set<string>,
    referencedInEdits: Set<string>,
    threshold: number,
  ): MonitorSignals.Warning | undefined {
    let unproductive = 0
    for (const file of readFiles) {
      if (!editedFiles.has(file) && !referencedInEdits.has(file)) {
        unproductive++
      }
    }

    if (unproductive >= threshold) {
      return {
        signal: "unproductive_reads",
        severity: "info",
        message: `${unproductive} files read but never used — consider being more targeted in file exploration`,
      }
    }

    return undefined
  }

  /**
   * Extracts lowercase keywords from a goal string for drift detection.
   *
   * @param goal - The goal text
   * @returns Array of meaningful keywords
   */
  export function extractGoalKeywords(goal: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "shall", "can", "need", "must", "to", "of",
      "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
      "and", "but", "or", "not", "no", "so", "if", "then", "than", "that",
      "this", "it", "its", "all", "each", "every", "some", "any", "few",
      "more", "most", "other", "such", "only", "same", "just", "also",
    ])

    return goal
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w))
  }
}
