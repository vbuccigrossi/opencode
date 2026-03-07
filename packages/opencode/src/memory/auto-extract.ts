import { Log } from "@/util/log"
import { Memory } from "."
import type { SessionState } from "@/session/state"
import type { MessageV2 } from "@/session/message-v2"
import type { TaskClassifier } from "@/strategy/classifier"

/**
 * Automatic insight extraction — captures working strategies, error-fix
 * patterns, and file expertise from completed sessions.
 *
 * Runs at the end of successful tasks to build genuine project expertise
 * over time. The extracted memories are stored via the Memory system and
 * recalled on future similar tasks.
 */
export namespace AutoExtract {
  const log = Log.create({ service: "memory.auto-extract" })

  /** A candidate memory to potentially store. */
  export interface MemoryCandidate {
    content: string
    type: string
    tags: string[]
  }

  /**
   * Extracts strategy insights from a completed session.
   *
   * Analyzes the session state (task type, strategy used, verification
   * results) to determine what worked and what didn't.
   *
   * @param state - Final session state
   * @param taskType - The classified task type
   * @param verifyPassed - Whether verification passed on first try
   * @returns Array of memory candidates
   */
  export function fromSession(
    state: SessionState.State,
    taskType: TaskClassifier.TaskType,
    verifyPassed: boolean,
  ): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = []

    // Strategy outcome
    if (state.plan.length > 0) {
      const doneSteps = state.plan.filter((s) => s.status === "done").length
      const totalSteps = state.plan.length
      const failedSteps = state.plan.filter((s) => s.status === "failed").length

      if (doneSteps === totalSteps && verifyPassed) {
        // Perfect execution — strong positive signal
        const files = state.workingSet.slice(0, 5).join(", ")
        candidates.push({
          content: `For ${taskType} tasks involving ${files || "similar files"}: plan with ${totalSteps} steps worked well. All steps completed, verification passed first try.`,
          type: "strategy",
          tags: [taskType, "success"],
        })
      }

      if (failedSteps > 0 && state.failedApproaches.length > 0) {
        // Record what didn't work
        for (const failure of state.failedApproaches) {
          candidates.push({
            content: `Failed approach for ${taskType}: ${failure.approach} — ${failure.reason}`,
            type: "debugging",
            tags: [taskType, "failure"],
          })
        }
      }
    }

    // Decisions worth remembering
    for (const decision of state.decisions) {
      if (decision.alternatives && decision.alternatives.length > 0) {
        candidates.push({
          content: `Decision: chose ${decision.choice} over ${decision.alternatives.join(", ")} because ${decision.reason}`,
          type: "architecture",
          tags: [taskType, "decision"],
        })
      }
    }

    // Invariants established
    for (const invariant of state.invariants) {
      candidates.push({
        content: `Invariant: ${invariant}`,
        type: "convention",
        tags: ["invariant"],
      })
    }

    return candidates
  }

  /**
   * Extracts an error-fix pattern from a successful verification repair.
   *
   * Generalizes the error message (removes line numbers) and captures
   * the nature of the fix for future recall.
   *
   * @param errorMessage - The original error message
   * @param fixDescription - What was done to fix it
   * @param filePath - File that was fixed
   * @returns A memory candidate, or undefined if not generalizable
   */
  export function fromRepair(
    errorMessage: string,
    fixDescription: string,
    filePath?: string,
  ): MemoryCandidate | undefined {
    // Generalize the error — remove line numbers and specific identifiers
    const generalized = generalizeError(errorMessage)
    if (!generalized) return undefined

    const fileHint = filePath ? ` in ${filePath.split("/").pop()}` : ""

    return {
      content: `Error pattern: "${generalized}"${fileHint} — Fix: ${fixDescription}`,
      type: "debugging",
      tags: ["error-fix", "auto-extracted"],
    }
  }

  /**
   * Stores extracted candidates via the Memory system.
   *
   * Deduplication is handled by Memory.store() — identical content
   * will be auto-updated instead of creating duplicates.
   *
   * @param candidates - Memory candidates to store
   * @returns Number of memories actually stored
   */
  export function store(candidates: MemoryCandidate[]): number {
    let stored = 0

    for (const candidate of candidates) {
      try {
        Memory.store(
          candidate.content,
          candidate.type as any,
          candidate.tags,
        )
        stored++
      } catch (err) {
        log.warn("failed to store extracted memory", { error: err })
      }
    }

    if (stored > 0) {
      log.info("auto-extracted memories stored", { count: stored })
    }

    return stored
  }

  // ─── Internal Helpers ────────────────────────────────────────

  /**
   * Generalizes an error message by removing line numbers, column numbers,
   * and specific identifiers, making it matchable across occurrences.
   *
   * @param error - Raw error message
   * @returns Generalized pattern, or undefined if too short
   */
  function generalizeError(error: string): string | undefined {
    if (error.length < 20) return undefined

    let generalized = error
      // Remove line:column references
      .replace(/\(\d+,\d+\)/g, "")
      .replace(/:\d+:\d+/g, "")
      .replace(/line \d+/gi, "line N")
      // Remove specific file paths but keep the error code
      .replace(/\/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs)/g, "<file>")
      // Remove specific type names in quotes (but keep the pattern)
      .replace(/'[A-Z]\w+'/g, "'<Type>'")
      // Clean up extra spaces
      .replace(/\s+/g, " ")
      .trim()

    return generalized.length >= 20 ? generalized : undefined
  }
}
