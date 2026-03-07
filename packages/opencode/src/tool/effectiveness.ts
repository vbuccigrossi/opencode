import { Log } from "@/util/log"

/**
 * Tool effectiveness tracking — learns which tools work best
 * per project and operation type.
 *
 * Tracks success/failure rates and durations, then produces
 * recommendations for tool selection. Stats persist across sessions
 * within a process (in-memory).
 */
export namespace ToolEffectiveness {
  const log = Log.create({ service: "tool.effectiveness" })

  /** A record of a single tool use. */
  export interface Record {
    /** Tool ID. */
    tool: string
    /** Operation within the tool (e.g., "search", "edit", "read"). */
    operation?: string
    /** Whether the tool use succeeded. */
    success: boolean
    /** Execution duration in ms. */
    duration: number
    /** Brief context (what was being done). */
    context?: string
    /** Timestamp of the record. */
    timestamp: number
  }

  /** Aggregated statistics for a tool. */
  export interface Stats {
    /** Success rate (0-1). */
    successRate: number
    /** Average duration in ms. */
    avgDuration: number
    /** Total number of uses. */
    uses: number
    /** Number of successes. */
    successes: number
    /** Number of failures. */
    failures: number
  }

  /** Per-project records. */
  const projectRecords = new Map<string, Record[]>()

  /** Max records to keep per project (rolling window). */
  const MAX_RECORDS = 500

  /** Min uses before a tool gets a recommendation. */
  const MIN_USES_FOR_RECOMMENDATION = 5

  /**
   * Record a tool use outcome.
   *
   * Fire-and-forget — this never throws or blocks.
   *
   * @param projectID - Project identifier
   * @param entry - The tool use record
   */
  export function record(projectID: string, entry: Record): void {
    try {
      let records = projectRecords.get(projectID)
      if (!records) {
        records = []
        projectRecords.set(projectID, records)
      }

      records.push(entry)

      // Rolling window
      if (records.length > MAX_RECORDS) {
        projectRecords.set(projectID, records.slice(-MAX_RECORDS))
      }
    } catch {
      // Never fail on recording
    }
  }

  /**
   * Get effectiveness stats for a specific tool.
   *
   * @param projectID - Project identifier
   * @param tool - Tool ID
   * @param operation - Optional operation filter
   * @returns Aggregated statistics
   */
  export function stats(
    projectID: string,
    tool: string,
    operation?: string,
  ): Stats {
    const records = projectRecords.get(projectID) ?? []
    const filtered = records.filter(
      (r) => r.tool === tool && (!operation || r.operation === operation),
    )

    if (filtered.length === 0) {
      return { successRate: 0, avgDuration: 0, uses: 0, successes: 0, failures: 0 }
    }

    const successes = filtered.filter((r) => r.success).length
    const totalDuration = filtered.reduce((sum, r) => sum + r.duration, 0)

    return {
      successRate: successes / filtered.length,
      avgDuration: Math.round(totalDuration / filtered.length),
      uses: filtered.length,
      successes,
      failures: filtered.length - successes,
    }
  }

  /**
   * Get all tool stats for a project, sorted by usage.
   *
   * @param projectID - Project identifier
   * @returns Map of tool ID to stats
   */
  export function allStats(projectID: string): Map<string, Stats> {
    const records = projectRecords.get(projectID) ?? []
    const tools = new Set(records.map((r) => r.tool))
    const result = new Map<string, Stats>()

    for (const tool of tools) {
      result.set(tool, stats(projectID, tool))
    }

    return result
  }

  /**
   * Get the most effective tool for an operation type.
   *
   * Considers only tools with enough usage data and returns
   * the one with the highest success rate.
   *
   * @param projectID - Project identifier
   * @param operation - Operation type (e.g., "search", "read")
   * @returns Recommended tool ID, or undefined if no data
   */
  export function recommend(
    projectID: string,
    operation: string,
  ): string | undefined {
    const records = projectRecords.get(projectID) ?? []
    const toolStats = new Map<string, { successes: number; total: number; avgDuration: number }>()

    for (const record of records) {
      if (record.operation !== operation) continue

      const existing = toolStats.get(record.tool) ?? { successes: 0, total: 0, avgDuration: 0 }
      existing.total++
      if (record.success) existing.successes++
      existing.avgDuration = (existing.avgDuration * (existing.total - 1) + record.duration) / existing.total
      toolStats.set(record.tool, existing)
    }

    let bestTool: string | undefined
    let bestScore = -1

    for (const [tool, stat] of toolStats) {
      if (stat.total < MIN_USES_FOR_RECOMMENDATION) continue

      // Score: 70% success rate + 30% speed (normalized)
      const successScore = stat.successes / stat.total
      const speedScore = Math.max(0, 1 - stat.avgDuration / 10000) // Normalize to 10s
      const score = successScore * 0.7 + speedScore * 0.3

      if (score > bestScore) {
        bestScore = score
        bestTool = tool
      }
    }

    return bestTool
  }

  /**
   * Format tool hints for system prompt injection.
   *
   * Only includes tools with meaningful data (5+ uses).
   *
   * @param projectID - Project identifier
   * @returns Formatted `<tool-hints>` block, or empty string if no data
   */
  export function format(projectID: string): string {
    const all = allStats(projectID)
    const hints: string[] = []

    for (const [tool, stat] of all) {
      if (stat.uses < MIN_USES_FOR_RECOMMENDATION) continue

      const rate = (stat.successRate * 100).toFixed(0)
      const avgMs = stat.avgDuration
      hints.push(`  ${tool}: ${rate}% success rate (${stat.uses} uses, avg ${avgMs}ms)`)
    }

    if (hints.length === 0) return ""

    return `<tool-hints>\n${hints.join("\n")}\n</tool-hints>`
  }

  /**
   * Get total record count for a project.
   *
   * @param projectID - Project identifier
   * @returns Number of records
   */
  export function recordCount(projectID: string): number {
    return (projectRecords.get(projectID) ?? []).length
  }

  /**
   * Clear records for a project.
   *
   * @param projectID - Project identifier
   */
  export function clear(projectID: string): void {
    projectRecords.delete(projectID)
  }

  /**
   * Clear all records.
   */
  export function clearAll(): void {
    projectRecords.clear()
  }
}
