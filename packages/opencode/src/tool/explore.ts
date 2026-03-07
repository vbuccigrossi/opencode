import z from "zod"
import { Tool } from "./tool"
import { Explore } from "../explore"

/**
 * Explore tool — parallel exploration for efficient codebase investigation.
 *
 * Operations:
 * - fan: Execute multiple exploration queries in parallel
 * - investigate: Auto-generate and execute queries from a natural language question
 */
export const ExploreTool = Tool.define("explore", {
  description: `Execute multiple codebase exploration queries in parallel for efficient investigation.

Operations:
- fan: Run multiple queries concurrently (read_file, grep, graph_callers, git_history, git_blame)
- investigate: Ask a question and let the tool auto-generate and execute relevant queries

Use this tool when you need to gather information from multiple sources at once:
- Reading several related files to understand a feature
- Checking git history AND current code for a file
- Finding callers of a function AND reading its implementation
- Investigating a bug across multiple files

Query types for fan operation:
- read_file: Read a file's signatures and first N lines (params: path, max_lines?)
- grep: Search for a pattern (params: pattern, glob?, max_results?)
- graph_callers: Find callers of a symbol (params: symbol)
- git_history: Recent commits for a file (params: path?, max_count?)
- git_blame: Blame a line range (params: path, start_line?, end_line?)

This is more efficient than making 5 sequential tool calls — all queries run concurrently.`,
  parameters: z.object({
    operation: z
      .enum(["fan", "investigate"])
      .describe("The exploration operation to perform"),
    queries: z
      .array(
        z.object({
          id: z.string().describe("Unique identifier for this query"),
          type: z
            .enum(["read_file", "grep", "graph_callers", "git_history", "git_blame"])
            .describe("Query type"),
          params: z.record(z.string(), z.any()).describe("Query parameters"),
        }),
      )
      .optional()
      .describe("Array of queries to execute in parallel (required for fan)"),
    question: z
      .string()
      .optional()
      .describe("Natural language question about the codebase (required for investigate)"),
  }),
  async execute(params, ctx) {
    switch (params.operation) {
      case "fan":
        return exploreFan(params.queries)
      case "investigate":
        return exploreInvestigate(params.question)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
})

/** Execute parallel queries. */
async function exploreFan(
  queries?: Explore.Query[],
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!queries || queries.length === 0) {
    throw new Error("queries parameter is required for fan operation (must be non-empty array)")
  }

  const results = await Explore.fan(queries)
  const summary = Explore.summarize(results)
  const succeeded = results.filter((r) => r.success).length

  return {
    title: `explore: ${succeeded}/${results.length} queries`,
    metadata: {
      truncated: false,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      queryTypes: queries.map((q) => q.type),
    },
    output: summary,
  }
}

/** Auto-investigate a question. */
async function exploreInvestigate(
  question?: string,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!question) {
    throw new Error("question parameter is required for investigate operation")
  }

  const { summary, results } = await Explore.investigate(question)
  const succeeded = results.filter((r) => r.success).length

  return {
    title: `explore: investigate (${results.length} queries)`,
    metadata: {
      truncated: false,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      question,
    },
    output: summary,
  }
}
