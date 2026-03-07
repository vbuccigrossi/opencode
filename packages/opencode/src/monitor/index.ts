import { Log } from "@/util/log"
import { MonitorSignals } from "./signals"
import { MonitorPatterns } from "./patterns"
import type { MessageV2 } from "@/session/message-v2"
import { SessionState } from "@/session/state"

/**
 * Meta-cognitive monitor — a lightweight heuristic system that tracks
 * agent behavior across steps and surfaces warnings when problematic
 * patterns are detected.
 *
 * The monitor runs between steps as a synchronous post-step hook.
 * No LLM calls — pure heuristics for sub-millisecond performance.
 *
 * When signals fire, a compact `<monitor>` XML block is injected
 * into the system prompt. When no signals fire, the block is omitted
 * (zero overhead).
 */
export namespace Monitor {
  const log = Log.create({ service: "monitor" })

  /** Per-session tracking state. */
  export interface State {
    /** Current step number */
    step: number
    /** Files read and their read counts */
    readCounts: Map<string, number>
    /** Files edited and their edit counts */
    editCounts: Map<string, number>
    /** Total verification failures */
    verificationFailures: number
    /** Consecutive verification failures (resets on success) */
    consecutiveFailures: number
    /** Recent tool calls for drift detection */
    recentTools: Array<{ tool: string; files: string[] }>
    /** Files referenced in edit inputs (imports, etc.) */
    referencedInEdits: Set<string>
    /** Token usage estimate */
    tokenEstimate: { used: number; total: number }
    /** Last known checkpoint */
    checkpoint?: string
    /** Last known goal keywords */
    goalKeywords: string[]
    /** Full goal text */
    goal: string
  }

  /** Per-session state storage. */
  const sessions = new Map<string, State>()

  /**
   * Gets or creates the monitor state for a session.
   *
   * @param sessionID - Session identifier
   * @returns Monitor state
   */
  export function getState(sessionID: string): State {
    let state = sessions.get(sessionID)
    if (!state) {
      state = createState()
      sessions.set(sessionID, state)
    }
    return state
  }

  /**
   * Clears state for a session.
   *
   * @param sessionID - Session identifier
   */
  export function clear(sessionID: string): void {
    sessions.delete(sessionID)
  }

  /**
   * Creates a fresh monitor state.
   *
   * @returns New state with all counters at zero
   */
  export function createState(): State {
    return {
      step: 0,
      readCounts: new Map(),
      editCounts: new Map(),
      verificationFailures: 0,
      consecutiveFailures: 0,
      recentTools: [],
      referencedInEdits: new Set(),
      tokenEstimate: { used: 0, total: 0 },
      goal: "",
      goalKeywords: [],
    }
  }

  /**
   * Records tool calls from a completed step into monitor state.
   *
   * Called after each processor step to accumulate signal data.
   *
   * @param sessionID - Session identifier
   * @param parts - Tool parts from the completed step
   */
  export function recordStep(
    sessionID: string,
    parts: MessageV2.ToolPart[],
  ): void {
    const state = getState(sessionID)
    state.step++

    for (const part of parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed" && part.state.status !== "error") continue

      const input = part.state.input as Record<string, unknown> | undefined
      const files: string[] = []

      // Extract file references from tool input
      if (input) {
        const filePath = input.file_path as string | undefined
        if (filePath) {
          const normalized = normalizeForTracking(filePath)
          files.push(normalized)

          // Track reads and edits
          switch (part.tool) {
            case "read":
              state.readCounts.set(normalized, (state.readCounts.get(normalized) ?? 0) + 1)
              break
            case "edit":
            case "write":
            case "apply_patch":
              state.editCounts.set(normalized, (state.editCounts.get(normalized) ?? 0) + 1)
              break
          }
        }

        // Track pattern references in edits
        if (part.tool === "edit" || part.tool === "write") {
          const content = (input.old_string as string) ?? (input.content as string) ?? ""
          extractImportPaths(content).forEach((p) => state.referencedInEdits.add(p))
        }
      }

      // Track verification results
      if (part.tool === "verify") {
        if (part.state.status === "error" || (part.state.output && typeof part.state.output === "string" && part.state.output.includes("error"))) {
          state.verificationFailures++
          state.consecutiveFailures++
        } else {
          state.consecutiveFailures = 0
        }
      }

      // Record for drift detection (keep last 20)
      state.recentTools.push({ tool: part.tool, files })
      if (state.recentTools.length > 20) {
        state.recentTools.shift()
      }
    }
  }

  /**
   * Updates token usage estimates.
   *
   * @param sessionID - Session identifier
   * @param used - Tokens used so far
   * @param total - Total context window tokens
   */
  export function updateTokens(
    sessionID: string,
    used: number,
    total: number,
  ): void {
    const state = getState(sessionID)
    state.tokenEstimate = { used, total }
  }

  /**
   * Runs all pattern detectors and returns any active warnings.
   *
   * Called at the start of each step to check if any signals fire.
   * Returns warnings sorted by severity (critical first).
   *
   * @param sessionID - Session identifier
   * @param messages - Conversation messages (for session state extraction)
   * @param thresholds - Optional custom thresholds
   * @returns Array of active warnings
   */
  export function check(
    sessionID: string,
    messages: MessageV2.WithParts[],
    thresholds: MonitorSignals.Thresholds = MonitorSignals.DEFAULT_THRESHOLDS,
  ): MonitorSignals.Warning[] {
    const state = getState(sessionID)

    // Sync with session state for goal/checkpoint
    try {
      const sessionState = SessionState.extract(messages)
      if (sessionState) {
        if (sessionState.goal && sessionState.goal !== state.goal) {
          state.goal = sessionState.goal
          state.goalKeywords = MonitorPatterns.extractGoalKeywords(sessionState.goal)
        }
        if (sessionState.checkpoint) {
          state.checkpoint = sessionState.checkpoint
        }
      }
    } catch {
      // Non-critical
    }

    const warnings: MonitorSignals.Warning[] = []

    // 1. Circular edits
    warnings.push(
      ...MonitorPatterns.detectCircularEdits(state.editCounts, thresholds.circularEdits),
    )

    // 2. Redundant reads
    const editedFiles = new Set(state.editCounts.keys())
    warnings.push(
      ...MonitorPatterns.detectRedundantReads(state.readCounts, editedFiles, thresholds.redundantReads),
    )

    // 3. Verification spiral
    const spiralWarning = MonitorPatterns.detectVerificationSpiral(
      state.consecutiveFailures,
      thresholds.verificationSpiral,
      state.checkpoint,
    )
    if (spiralWarning) warnings.push(spiralWarning)

    // 4. Context burn rate
    if (state.tokenEstimate.total > 0) {
      const usageRatio = state.tokenEstimate.used / state.tokenEstimate.total
      const burnWarning = MonitorPatterns.detectContextBurn(
        usageRatio,
        state.step,
        thresholds.contextBurnWarn,
        thresholds.contextBurnCritical,
      )
      if (burnWarning) warnings.push(burnWarning)
    }

    // 5. Goal drift
    if (state.goal) {
      const workingFiles = new Set([...editedFiles, ...state.readCounts.keys()])
      const driftWarning = MonitorPatterns.detectGoalDrift(
        state.recentTools,
        state.goalKeywords,
        workingFiles,
        thresholds.goalDriftSteps,
        state.goal,
      )
      if (driftWarning) warnings.push(driftWarning)
    }

    // 6. Unproductive reads
    const readFiles = new Set(state.readCounts.keys())
    const unproductiveWarning = MonitorPatterns.detectUnproductiveReads(
      readFiles,
      editedFiles,
      state.referencedInEdits,
      thresholds.unproductiveReads,
    )
    if (unproductiveWarning) warnings.push(unproductiveWarning)

    return sortBySeverity(warnings)
  }

  /**
   * Formats warnings into a compact `<monitor>` XML block.
   *
   * Only produces output when there are active warnings.
   * Returns empty string when no signals fire (zero overhead).
   *
   * @param warnings - Active warnings from check()
   * @param step - Current step number
   * @param tokenUsage - Optional context usage info
   * @returns Formatted XML block or empty string
   */
  export function format(
    warnings: MonitorSignals.Warning[],
    step: number,
    tokenUsage?: { used: number; total: number },
  ): string {
    if (warnings.length === 0) return ""

    const lines: string[] = []

    // Always show step count
    lines.push(`Step ${step}`)

    // Show context usage if available
    if (tokenUsage && tokenUsage.total > 0) {
      const pct = Math.round((tokenUsage.used / tokenUsage.total) * 100)
      lines.push(`Context: ${pct}% used`)
    }

    // Show warnings
    for (const w of warnings) {
      const prefix = w.severity === "critical" ? "CRITICAL" : w.severity === "warn" ? "Warning" : "Note"
      lines.push(`${prefix}: ${w.message}`)
    }

    return `<monitor>\n${lines.join("\n")}\n</monitor>`
  }

  // ─── Internal Helpers ────────────────────────────────────────

  /** Severity order for sorting. */
  const SEVERITY_ORDER: Record<string, number> = {
    critical: 0,
    warn: 1,
    info: 2,
  }

  /**
   * Sorts warnings by severity (critical first).
   *
   * @param warnings - Unsorted warnings
   * @returns Sorted warnings
   */
  function sortBySeverity(warnings: MonitorSignals.Warning[]): MonitorSignals.Warning[] {
    return warnings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2))
  }

  /**
   * Normalizes a file path for consistent tracking.
   *
   * @param filePath - Raw file path
   * @returns Normalized path
   */
  function normalizeForTracking(filePath: string): string {
    // Remove common absolute prefixes for consistent comparison
    return filePath.replace(/^\/[^/]+\/[^/]+\/[^/]+\/[^/]+\//, "")
  }

  /**
   * Extracts import/require paths from code content.
   * Used to track which files are referenced in edits.
   *
   * @param content - Code content
   * @returns Set of referenced file paths
   */
  function extractImportPaths(content: string): string[] {
    const paths: string[] = []
    // Match import "..." or from "..." or require("...")
    const importRegex = /(?:import|from|require)\s*\(?\s*["']([^"']+)["']/g
    let match: RegExpExecArray | null
    while ((match = importRegex.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith("@") && match[1].includes("/")) {
        paths.push(match[1])
      }
    }
    return paths
  }
}
