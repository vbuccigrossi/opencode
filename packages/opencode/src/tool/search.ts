import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { GitHistory } from "../search/git-history"
import { DocSearch } from "../search/docs"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

/**
 * Enhanced search tool — unified search across code, git history, and documentation.
 *
 * Provides structured search capabilities beyond basic grep/glob.
 */
export const SearchTool = Tool.define("search", async () => ({
  description: `Search across git history, documentation, and symbols with structured results.

Operations:
- history: Search git commit messages for a query. Use to understand why code was changed.
- blame: Show who wrote each line of a file and when (structured git blame).
- pickaxe: Find commits that introduced or removed specific text. Answers "when was this added?" or "who removed this?"
- docs: Search documentation files (README, docs/, changelogs) with relevance scoring.
- explain: Find all documentation for a specific symbol (docstrings, README mentions, test descriptions).
- commit_range: Show commits between two refs (useful for regression analysis).

For basic code content search, use the grep tool. For file name search, use the glob tool.
This tool is for git history analysis and documentation search.`,
  parameters: z.object({
    operation: z
      .enum(["history", "blame", "pickaxe", "docs", "explain", "commit_range"])
      .describe("The search operation to perform"),
    query: z.string().optional().describe("Search query text (for history, pickaxe, docs, explain)"),
    file: z.string().optional().describe("File path (for blame, history with file filter)"),
    line_start: z.number().optional().describe("Start line for blame range (1-based)"),
    line_end: z.number().optional().describe("End line for blame range"),
    ref_from: z.string().optional().describe("Starting ref (for commit_range)"),
    ref_to: z.string().optional().describe("Ending ref (for commit_range)"),
    author: z.string().optional().describe("Filter by author (for history)"),
    since: z.string().optional().describe("Filter since date, e.g. '2 weeks ago' (for history)"),
    max_results: z.number().optional().describe("Maximum results to return (default: 20)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "history":
        return searchHistory(params)
      case "blame":
        return searchBlame(params)
      case "pickaxe":
        return searchPickaxe(params)
      case "docs":
        return searchDocs(params)
      case "explain":
        return searchExplain(params)
      case "commit_range":
        return searchCommitRange(params)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.search" })

async function searchHistory(params: {
  query?: string
  file?: string
  author?: string
  since?: string
  max_results?: number
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.query && !params.file) throw new Error("query or file parameter is required for history search")

  const commits = await GitHistory.logHistory(Instance.directory, {
    grep: params.query,
    file: params.file,
    author: params.author,
    since: params.since,
    maxCount: params.max_results ?? 20,
    follow: !!params.file,
  })

  return {
    title: `search: ${commits.length} commit(s)`,
    metadata: { count: commits.length, query: params.query },
    output: commits.length === 0
      ? `No commits found matching "${params.query ?? params.file}".`
      : GitHistory.format(commits),
  }
}

async function searchBlame(params: {
  file?: string
  line_start?: number
  line_end?: number
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.file) throw new Error("file parameter is required for blame")

  const filePath = params.file
  const lineRange: [number, number] | undefined =
    params.line_start && params.line_end ? [params.line_start, params.line_end] : undefined

  const blameLines = await GitHistory.blame(Instance.directory, filePath, lineRange)

  if (blameLines.length === 0) {
    return {
      title: `search: blame ${path.basename(filePath)}`,
      metadata: { file: filePath, lines: 0 },
      output: "No blame data available.",
    }
  }

  const lines = blameLines.map(
    (b) => `${b.line.toString().padStart(4)} │ ${b.commit} ${b.date.substring(0, 10)} ${b.author.padEnd(15).substring(0, 15)} │ ${b.content}`,
  )

  // Summarize top contributors
  const authors = new Map<string, number>()
  for (const b of blameLines) {
    authors.set(b.author, (authors.get(b.author) ?? 0) + 1)
  }
  const topAuthors = [...authors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}: ${count} lines`)

  return {
    title: `search: blame ${path.basename(filePath)}`,
    metadata: { file: filePath, lines: blameLines.length, topAuthors },
    output: `Blame for ${filePath}${lineRange ? ` (L${lineRange[0]}-L${lineRange[1]})` : ""}:\n\nTop contributors: ${topAuthors.join(", ")}\n\n${lines.join("\n")}`,
  }
}

async function searchPickaxe(params: {
  query?: string
  file?: string
  author?: string
  since?: string
  max_results?: number
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.query) throw new Error("query parameter is required for pickaxe search")

  const commits = await GitHistory.pickaxe(Instance.directory, params.query, {
    file: params.file,
    author: params.author,
    since: params.since,
    maxCount: params.max_results ?? 20,
  })

  return {
    title: `search: pickaxe "${params.query}" (${commits.length} commits)`,
    metadata: { count: commits.length, query: params.query },
    output: commits.length === 0
      ? `No commits found that introduced or removed "${params.query}".`
      : `Commits that introduced or removed "${params.query}":\n\n${GitHistory.format(commits)}`,
  }
}

async function searchDocs(params: {
  query?: string
  max_results?: number
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.query) throw new Error("query parameter is required for docs search")

  const docIndex = await DocSearch.index(Instance.directory)
  const results = DocSearch.search(docIndex, params.query, params.max_results ?? 10)

  return {
    title: `search: docs "${params.query}" (${results.length} results)`,
    metadata: { count: results.length, indexed: docIndex.files.length },
    output: results.length === 0
      ? `No documentation found for "${params.query}".`
      : `Documentation results for "${params.query}" (${docIndex.files.length} files indexed):\n\n${DocSearch.format(results, Instance.directory)}`,
  }
}

async function searchExplain(params: {
  query?: string
  max_results?: number
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.query) throw new Error("query parameter is required for explain")

  const docIndex = await DocSearch.index(Instance.directory)
  const results = DocSearch.explain(docIndex, params.query)

  if (results.length === 0) {
    return {
      title: `search: explain "${params.query}"`,
      metadata: { count: 0 },
      output: `No documentation found for symbol "${params.query}".`,
    }
  }

  const sections: string[] = [`Documentation for "${params.query}":\n`]
  for (const r of results) {
    const file = path.relative(Instance.directory, r.file)
    sections.push(`[${r.source}] ${file}:${r.line}`)
    sections.push(r.snippet)
    sections.push("")
  }

  return {
    title: `search: explain "${params.query}" (${results.length} sources)`,
    metadata: { count: results.length, sources: [...new Set(results.map((r) => r.source))] },
    output: sections.join("\n"),
  }
}

async function searchCommitRange(params: {
  ref_from?: string
  ref_to?: string
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.ref_from || !params.ref_to) throw new Error("ref_from and ref_to parameters are required for commit_range")

  const commits = await GitHistory.commitRange(Instance.directory, params.ref_from, params.ref_to)

  return {
    title: `search: ${commits.length} commits in ${params.ref_from}..${params.ref_to}`,
    metadata: { count: commits.length, from: params.ref_from, to: params.ref_to },
    output: commits.length === 0
      ? `No commits found between ${params.ref_from} and ${params.ref_to}.`
      : `${commits.length} commits between ${params.ref_from} and ${params.ref_to}:\n\n${GitHistory.format(commits)}`,
  }
}
