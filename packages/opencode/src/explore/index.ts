import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { ExploreQueries } from "./queries"

/**
 * Parallel exploration engine — executes multiple research queries
 * concurrently and merges results into a compact summary.
 *
 * Replaces the pattern of sequential tool calls for investigation
 * tasks (checking git history, reading related files, grepping,
 * querying the graph) with a single fan-out operation.
 */
export namespace Explore {
  const log = Log.create({ service: "explore" })

  /** Re-export types for convenience. */
  export type Query = ExploreQueries.Query
  export type Result = ExploreQueries.Result
  export type QueryType = ExploreQueries.QueryType

  /** Max total summary length (characters) across all results. */
  const MAX_TOTAL = 8000

  /** Max concurrent queries to avoid overwhelming the system. */
  const MAX_CONCURRENT = 10

  /**
   * Execute multiple exploration queries in parallel.
   *
   * All queries run concurrently via Promise.all, with a cap on
   * concurrent executions. Results are returned in order.
   *
   * @param queries - Array of queries to execute
   * @param cwd - Working directory (defaults to Instance.directory)
   * @returns Array of results, one per query
   */
  export async function fan(
    queries: Query[],
    cwd?: string,
  ): Promise<Result[]> {
    const dir = cwd ?? Instance.directory

    if (queries.length === 0) return []
    if (queries.length > MAX_CONCURRENT) {
      log.warn("too many queries, capping", { requested: queries.length, max: MAX_CONCURRENT })
      queries = queries.slice(0, MAX_CONCURRENT)
    }

    const startTime = Date.now()

    const results = await Promise.all(
      queries.map((q) => ExploreQueries.execute(q, dir)),
    )

    const duration = Date.now() - startTime
    const succeeded = results.filter((r) => r.success).length

    log.info("fan-out complete", {
      total: queries.length,
      succeeded,
      failed: queries.length - succeeded,
      duration,
    })

    return results
  }

  /**
   * Merge results into a compact exploration summary.
   *
   * Combines all result summaries with headers, respecting the
   * total budget. Successful results are shown first.
   *
   * @param results - Array of query results
   * @returns Formatted summary string
   */
  export function summarize(results: Result[]): string {
    if (results.length === 0) return "No exploration results."

    const succeeded = results.filter((r) => r.success)
    const failed = results.filter((r) => !r.success)
    const sections: string[] = []

    sections.push(`Exploration: ${succeeded.length}/${results.length} queries succeeded`)
    sections.push("")

    let totalLength = sections.join("\n").length

    // Show successful results first
    for (const result of succeeded) {
      const header = `--- Query: ${result.queryId} ---`
      const content = result.summary
      const section = `${header}\n${content}`

      if (totalLength + section.length + 2 > MAX_TOTAL) {
        sections.push(`\n[${succeeded.length - sections.length + 2} more results truncated for space]`)
        break
      }

      sections.push(section)
      totalLength += section.length + 1
    }

    // Show failed results compactly
    if (failed.length > 0) {
      sections.push("")
      sections.push(`Failed queries (${failed.length}):`)
      for (const result of failed) {
        sections.push(`  ${result.queryId}: ${result.summary}`)
      }
    }

    return sections.join("\n")
  }

  /**
   * Higher-level investigation: given a question, auto-generate
   * relevant queries and execute them.
   *
   * Analyzes the question text to determine what queries to run:
   * - File references → read_file queries
   * - Symbol names → graph_callers queries
   * - "history"/"changed"/"blame" → git queries
   * - General terms → grep queries
   *
   * @param question - Natural language question about the codebase
   * @param cwd - Working directory
   * @returns Summarized investigation results
   */
  export async function investigate(
    question: string,
    cwd?: string,
  ): Promise<{ summary: string; results: Result[] }> {
    const queries = generateQueries(question)

    if (queries.length === 0) {
      return {
        summary: "Could not generate queries from the question. Try providing specific file paths or symbol names.",
        results: [],
      }
    }

    const results = await fan(queries, cwd)
    return {
      summary: summarize(results),
      results,
    }
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Generate queries from a natural language question.
   *
   * @param question - The question text
   * @returns Array of queries to execute
   */
  function generateQueries(question: string): Query[] {
    const queries: Query[] = []
    let queryIdx = 0

    // Extract file paths (things that look like paths)
    const pathPattern = /(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|h|hpp|md|json|yaml|yml|toml))/gi
    const paths = [...question.matchAll(pathPattern)].map((m) => m[1])

    for (const p of paths.slice(0, 3)) {
      queries.push({
        id: `read-${++queryIdx}`,
        type: "read_file",
        params: { path: p },
      })
    }

    // Extract potential symbol names (PascalCase or camelCase identifiers)
    const symbolPattern = /\b([A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z]+)?)\b/g
    const symbols = [...question.matchAll(symbolPattern)]
      .map((m) => m[1])
      .filter((s) => s.length > 2 && !["The", "This", "What", "How", "Why", "Where", "When", "Does", "Can"].includes(s))

    for (const sym of symbols.slice(0, 2)) {
      queries.push({
        id: `callers-${++queryIdx}`,
        type: "graph_callers",
        params: { symbol: sym },
      })
    }

    // Git-related keywords
    const gitKeywords = /\b(history|changed|blame|commit|modified|who|when|author)\b/i
    if (gitKeywords.test(question)) {
      const file = paths[0]
      queries.push({
        id: `history-${++queryIdx}`,
        type: "git_history",
        params: { path: file, max_count: 10 },
      })

      if (/blame|who|author/i.test(question) && file) {
        queries.push({
          id: `blame-${++queryIdx}`,
          type: "git_blame",
          params: { path: file, start_line: 1, end_line: 30 },
        })
      }
    }

    // If we have a meaningful search term but no path-specific queries
    const searchTerms = question
      .replace(/[?.,!;:'"()[\]{}]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !/^(what|where|when|does|this|that|with|from|have|they|been|will|should|would|could)$/i.test(w))

    if (searchTerms.length > 0 && queries.length < 5) {
      // Take the most specific-looking terms
      const grepTerm = searchTerms
        .sort((a, b) => b.length - a.length)
        .slice(0, 2)
        .join("|")

      queries.push({
        id: `grep-${++queryIdx}`,
        type: "grep",
        params: { pattern: grepTerm, max_results: 10 },
      })
    }

    return queries
  }
}
