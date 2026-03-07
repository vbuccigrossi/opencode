import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { readFile } from "fs/promises"
import { join, relative } from "path"
import { spawn } from "child_process"

/**
 * Query type implementations for parallel exploration.
 *
 * Each query type maps to an internal operation that returns a compact,
 * truncated summary suitable for combining with other query results.
 */
export namespace ExploreQueries {
  const log = Log.create({ service: "explore.queries" })

  /** Supported query types. */
  export type QueryType =
    | "read_file"
    | "grep"
    | "graph_callers"
    | "git_history"
    | "git_blame"

  /** A single exploration query. */
  export interface Query {
    /** Unique identifier for this query. */
    id: string
    /** Type of query to execute. */
    type: QueryType
    /** Parameters for the query. */
    params: Record<string, unknown>
  }

  /** Result of a single query execution. */
  export interface Result {
    /** ID of the query this result belongs to. */
    queryId: string
    /** Whether the query executed successfully. */
    success: boolean
    /** Compact summary of findings. */
    summary: string
    /** Original output length before truncation. */
    rawLength: number
    /** Whether the output was truncated. */
    truncated: boolean
  }

  /** Max summary length per query result (characters). */
  const MAX_SUMMARY = 2000

  /**
   * Execute a single query and return a compact result.
   *
   * @param query - The query to execute
   * @param cwd - Working directory
   * @returns Compact result
   */
  export async function execute(query: Query, cwd: string): Promise<Result> {
    try {
      switch (query.type) {
        case "read_file":
          return await readFileQuery(query, cwd)
        case "grep":
          return await grepQuery(query, cwd)
        case "graph_callers":
          return await graphCallersQuery(query, cwd)
        case "git_history":
          return await gitHistoryQuery(query, cwd)
        case "git_blame":
          return await gitBlameQuery(query, cwd)
        default:
          return {
            queryId: query.id,
            success: false,
            summary: `Unknown query type: ${query.type}`,
            rawLength: 0,
            truncated: false,
          }
      }
    } catch (err: any) {
      log.warn("query failed", { queryId: query.id, type: query.type, error: err.message })
      return {
        queryId: query.id,
        success: false,
        summary: `Error: ${err.message}`,
        rawLength: 0,
        truncated: false,
      }
    }
  }

  // ─── Query Implementations ────────────────────────────────────

  /**
   * Read a file — returns first N lines + function/class signatures.
   */
  async function readFileQuery(query: Query, cwd: string): Promise<Result> {
    const filePath = String(query.params.path ?? "")
    if (!filePath) return fail(query.id, "path parameter required")

    const fullPath = filePath.startsWith("/") ? filePath : join(cwd, filePath)
    const content = await readFile(fullPath, "utf-8")
    const lines = content.split("\n")
    const rawLength = content.length

    // Extract signatures (export, function, class, interface, type, const)
    const signaturePattern = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum|namespace)\s+/
    const signatures = lines
      .map((line, i) => ({ line: line.trim(), num: i + 1 }))
      .filter(({ line }) => signaturePattern.test(line))
      .slice(0, 30)

    const maxLines = Number(query.params.max_lines ?? 50)
    const preview = lines.slice(0, maxLines)
    const sections: string[] = []

    sections.push(`File: ${relative(cwd, fullPath)} (${lines.length} lines)`)

    if (signatures.length > 0) {
      sections.push(`\nSignatures (${signatures.length}):`)
      for (const sig of signatures) {
        sections.push(`  L${sig.num}: ${sig.line.slice(0, 120)}`)
      }
    }

    sections.push(`\nPreview (first ${preview.length} lines):`)
    for (let i = 0; i < preview.length; i++) {
      sections.push(`  ${i + 1}: ${preview[i]}`)
    }

    if (lines.length > maxLines) {
      sections.push(`  ... (${lines.length - maxLines} more lines)`)
    }

    const summary = sections.join("\n")
    return {
      queryId: query.id,
      success: true,
      summary: truncate(summary, MAX_SUMMARY),
      rawLength,
      truncated: summary.length > MAX_SUMMARY,
    }
  }

  /**
   * Search for a pattern via grep — returns top matches with context.
   */
  async function grepQuery(query: Query, cwd: string): Promise<Result> {
    const pattern = String(query.params.pattern ?? "")
    if (!pattern) return fail(query.id, "pattern parameter required")

    const glob = query.params.glob ? String(query.params.glob) : undefined
    const maxResults = Number(query.params.max_results ?? 10)

    const args = ["-rn", "--no-heading", "--color=never"]
    if (glob) args.push("--glob", glob)
    args.push("-m", String(maxResults * 3)) // Get more than needed, then trim
    args.push(pattern)

    const output = await runGit(["rg", ...args], cwd, 10000).catch(async () => {
      // Fallback to grep if rg not available
      const grepArgs = ["-rn", "--color=never"]
      if (glob) grepArgs.push("--include", glob)
      grepArgs.push(pattern, ".")
      return runGit(["grep", ...grepArgs], cwd, 10000)
    })

    const lines = output.split("\n").filter(Boolean).slice(0, maxResults)
    const rawLength = output.length

    const sections: string[] = []
    sections.push(`Grep: "${pattern}"${glob ? ` (glob: ${glob})` : ""} — ${lines.length} match(es)`)

    for (const line of lines) {
      sections.push(`  ${line.slice(0, 200)}`)
    }

    const summary = sections.join("\n")
    return {
      queryId: query.id,
      success: true,
      summary: truncate(summary, MAX_SUMMARY),
      rawLength,
      truncated: summary.length > MAX_SUMMARY,
    }
  }

  /**
   * Query the knowledge graph for callers of a symbol.
   */
  async function graphCallersQuery(query: Query, cwd: string): Promise<Result> {
    const symbol = String(query.params.symbol ?? "")
    if (!symbol) return fail(query.id, "symbol parameter required")

    try {
      const { Graph } = await import("@/graph")
      const projectID = Instance.project?.id ?? ""
      const callers = Graph.callersOf(projectID, symbol)

      const sections: string[] = []
      sections.push(`Callers of "${symbol}": ${callers.length} found`)

      for (const caller of callers.slice(0, 20)) {
        const loc = caller.filePath
          ? `${relative(cwd, caller.filePath)}:${caller.startLine ?? "?"}`
          : "unknown"
        sections.push(`  ${caller.name} (${caller.kind}) — ${loc}`)
      }

      if (callers.length > 20) {
        sections.push(`  ... and ${callers.length - 20} more`)
      }

      const summary = sections.join("\n")
      return {
        queryId: query.id,
        success: true,
        summary: truncate(summary, MAX_SUMMARY),
        rawLength: summary.length,
        truncated: summary.length > MAX_SUMMARY,
      }
    } catch {
      return fail(query.id, "Graph not available — index may not be built")
    }
  }

  /**
   * Get recent git history for a file.
   */
  async function gitHistoryQuery(query: Query, cwd: string): Promise<Result> {
    const filePath = query.params.path ? String(query.params.path) : undefined
    const maxCount = Number(query.params.max_count ?? 10)

    const args = ["log", `--max-count=${maxCount}`, "--pretty=format:%h %ad %an: %s", "--date=short"]
    if (filePath) args.push("--", filePath)

    const output = await runGit(["git", ...args], cwd, 10000)
    const lines = output.split("\n").filter(Boolean)

    const sections: string[] = []
    sections.push(`Git history${filePath ? ` for ${filePath}` : ""}: ${lines.length} commit(s)`)

    for (const line of lines) {
      sections.push(`  ${line}`)
    }

    const summary = sections.join("\n")
    return {
      queryId: query.id,
      success: true,
      summary: truncate(summary, MAX_SUMMARY),
      rawLength: output.length,
      truncated: summary.length > MAX_SUMMARY,
    }
  }

  /**
   * Blame a specific line range in a file.
   */
  async function gitBlameQuery(query: Query, cwd: string): Promise<Result> {
    const filePath = String(query.params.path ?? "")
    if (!filePath) return fail(query.id, "path parameter required")

    const startLine = Number(query.params.start_line ?? 1)
    const endLine = Number(query.params.end_line ?? startLine + 20)

    const args = [
      "blame",
      "--date=short",
      `-L${startLine},${endLine}`,
      filePath,
    ]

    const output = await runGit(["git", ...args], cwd, 10000)
    const lines = output.split("\n").filter(Boolean)

    const sections: string[] = []
    sections.push(`Blame: ${filePath} L${startLine}-${endLine} (${lines.length} lines)`)

    for (const line of lines) {
      sections.push(`  ${line.slice(0, 200)}`)
    }

    const summary = sections.join("\n")
    return {
      queryId: query.id,
      success: true,
      summary: truncate(summary, MAX_SUMMARY),
      rawLength: output.length,
      truncated: summary.length > MAX_SUMMARY,
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Run a command and return stdout. */
  function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
    const [cmd, ...rest] = args
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, rest, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.length > 100_000) {
          proc.kill("SIGTERM")
        }
      })
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const timer = setTimeout(() => {
        proc.kill("SIGTERM")
      }, timeoutMs)

      proc.on("close", (code) => {
        clearTimeout(timer)
        if (code === 0 || stdout.length > 0) {
          resolve(stdout)
        } else {
          reject(new Error(stderr.trim() || `Command failed with code ${code}`))
        }
      })

      proc.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /** Create a failure result. */
  function fail(queryId: string, message: string): Result {
    return {
      queryId,
      success: false,
      summary: `Error: ${message}`,
      rawLength: 0,
      truncated: false,
    }
  }

  /** Truncate a string to max length. */
  function truncate(str: string, max: number): string {
    if (str.length <= max) return str
    return str.slice(0, max - 20) + "\n[truncated...]"
  }
}
