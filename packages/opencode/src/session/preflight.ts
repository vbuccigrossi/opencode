import { Log } from "@/util/log"
import { Graph } from "@/graph"
import { Instance } from "@/project/instance"

/**
 * Pre-flight impact analysis — analyzes the blast radius of planned
 * changes before they're executed.
 *
 * Provides risk classification (low/medium/high) based on:
 * - Number of files affected
 * - Number of callers of modified entities
 * - Whether tests exist for affected code
 * - Whether exported interfaces/signatures are changing
 *
 * Used by the edit/write tools and the checkpoint system to decide
 * whether automatic checkpoints are needed.
 */
export namespace PreFlight {
  const log = Log.create({ service: "session.preflight" })

  /** Risk level classification. */
  export type RiskLevel = "low" | "medium" | "high"

  /** A planned change (file + nature of modification). */
  export interface PlannedChange {
    /** File being modified */
    filePath: string
    /** Whether function signatures or exports are being changed */
    signatureChange: boolean
    /** Approximate number of lines being changed */
    linesChanged: number
  }

  /** Result of pre-flight impact analysis. */
  export interface Analysis {
    /** Files directly modified */
    filesTouched: string[]
    /** Total number of callers across all modified entities */
    callersAffected: number
    /** Test files that cover the modified code */
    testsAffected: string[]
    /** Overall risk classification */
    riskLevel: RiskLevel
    /** Human-readable warnings */
    warnings: string[]
  }

  /**
   * Analyzes the impact of planned changes.
   *
   * Uses the graph to find callers and tests of entities in
   * the affected files. Risk is classified based on the blast
   * radius of the changes.
   *
   * @param changes - Array of planned changes
   * @returns Impact analysis with risk level and warnings
   */
  export function analyze(changes: PlannedChange[]): Analysis {
    const filesTouched = [...new Set(changes.map((c) => c.filePath))]
    const totalLines = changes.reduce((sum, c) => sum + c.linesChanged, 0)
    const hasSignatureChanges = changes.some((c) => c.signatureChange)
    const warnings: string[] = []

    let callersAffected = 0
    const testsAffected = new Set<string>()

    // Query graph for impact data
    try {
      const projectID = Instance.project?.id
      if (projectID) {
        for (const file of filesTouched) {
          const nodes = Graph.nodesInFile(projectID, normalizeForGraph(file))
          for (const node of nodes) {
            // Count callers
            const callers = Graph.callersOf(projectID, node.name)
            callersAffected += callers.length

            // Find related tests
            const tests = Graph.relatedTests(projectID, node.name)
            for (const t of tests) {
              if (t.filePath) testsAffected.add(t.filePath)
            }
          }
        }
      }
    } catch {
      // Graph not available — proceed with file-count-only analysis
    }

    // Build warnings
    if (filesTouched.length >= 4) {
      warnings.push(`Modifying ${filesTouched.length} files — consider incremental changes`)
    }
    if (callersAffected >= 10) {
      warnings.push(`${callersAffected} callers affected — high potential for cascading failures`)
    }
    if (hasSignatureChanges && callersAffected > 0) {
      warnings.push(`Signature changes with ${callersAffected} callers — type errors likely`)
    }
    if (testsAffected.size === 0 && totalLines > 20) {
      warnings.push("No test coverage detected for affected code")
    }

    // Classify risk
    const riskLevel = classifyRisk(filesTouched.length, callersAffected, hasSignatureChanges, totalLines)

    return {
      filesTouched,
      callersAffected,
      testsAffected: [...testsAffected],
      riskLevel,
      warnings,
    }
  }

  /**
   * Formats an analysis into a compact summary for injection.
   *
   * @param analysis - The analysis result
   * @returns Human-readable summary string
   */
  export function summarize(analysis: Analysis): string {
    const parts: string[] = []

    parts.push(`Risk: ${analysis.riskLevel}`)
    parts.push(`Files: ${analysis.filesTouched.length}`)

    if (analysis.callersAffected > 0) {
      parts.push(`Callers: ${analysis.callersAffected}`)
    }
    if (analysis.testsAffected.length > 0) {
      parts.push(`Tests: ${analysis.testsAffected.length}`)
    }

    const summary = parts.join(" | ")

    if (analysis.warnings.length > 0) {
      return `${summary}\n${analysis.warnings.map((w) => `⚠ ${w}`).join("\n")}`
    }

    return summary
  }

  /**
   * Quick risk check for a single file change (used by edit tool).
   *
   * @param filePath - File being modified
   * @param linesChanged - Number of lines changed
   * @returns Risk level
   */
  export function quickRisk(filePath: string, linesChanged: number): RiskLevel {
    if (linesChanged <= 10) return "low"

    try {
      const projectID = Instance.project?.id
      if (projectID) {
        const nodes = Graph.nodesInFile(projectID, normalizeForGraph(filePath))
        let totalCallers = 0
        for (const node of nodes) {
          totalCallers += Graph.callersOf(projectID, node.name).length
        }
        if (totalCallers >= 5) return "high"
        if (totalCallers >= 2 || linesChanged > 50) return "medium"
      }
    } catch {
      // Graph not available
    }

    return linesChanged > 50 ? "medium" : "low"
  }

  // ─── Internal Helpers ────────────────────────────────────────

  /**
   * Classifies risk based on multiple factors.
   *
   * @param fileCount - Number of files being modified
   * @param callers - Number of callers affected
   * @param signatureChange - Whether signatures are changing
   * @param linesChanged - Total lines being modified
   * @returns Risk level
   */
  function classifyRisk(
    fileCount: number,
    callers: number,
    signatureChange: boolean,
    linesChanged: number,
  ): RiskLevel {
    // High risk conditions
    if (fileCount >= 4) return "high"
    if (signatureChange && callers >= 5) return "high"
    if (callers >= 10) return "high"

    // Medium risk conditions
    if (fileCount >= 2) return "medium"
    if (signatureChange && callers > 0) return "medium"
    if (callers >= 3) return "medium"
    if (linesChanged > 50) return "medium"

    return "low"
  }

  /**
   * Normalizes a file path for graph queries.
   *
   * @param filePath - Absolute or relative path
   * @returns Relative path suitable for graph queries
   */
  function normalizeForGraph(filePath: string): string {
    try {
      const root = Instance.worktree
      if (root && filePath.startsWith(root)) {
        const rel = filePath.slice(root.length)
        return rel.startsWith("/") ? rel.slice(1) : rel
      }
    } catch {
      // Instance not initialized
    }
    return filePath
  }
}
