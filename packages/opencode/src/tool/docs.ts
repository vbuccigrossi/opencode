import z from "zod"
import { Tool } from "./tool"
import { Docs } from "../docs"
import { Instance } from "../project/instance"

/**
 * Documentation retrieval tool — indexes and looks up type information
 * from installed npm packages' .d.ts files.
 *
 * Operations:
 * - index: Index a package's type declarations
 * - lookup: Look up a specific symbol
 * - search: Search for symbols by name
 * - stats: Show index statistics
 */
export const DocsTool = Tool.define("docs", {
  description: `Look up type information from installed npm packages.

Operations:
- index: Index a package's .d.ts files (e.g., "zod", "express")
- lookup: Look up a specific symbol's type signature
- search: Search for symbols matching a query
- stats: Show how many packages and symbols are indexed

Use this instead of guessing at API signatures:
- Before using an unfamiliar package API, index it and look up the types
- When you need parameter types or return types for a function
- When you want to see what exports a package provides`,
  parameters: z.object({
    operation: z
      .enum(["index", "lookup", "search", "stats"])
      .describe("The documentation operation to perform"),
    package_name: z
      .string()
      .optional()
      .describe("Package name (required for index, optional filter for lookup)"),
    symbol: z
      .string()
      .optional()
      .describe("Symbol name (required for lookup)"),
    query: z
      .string()
      .optional()
      .describe("Search query (required for search)"),
    max_results: z
      .number()
      .optional()
      .describe("Maximum results for search (default: 10)"),
  }),
  async execute(params): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "index":
        return await docsIndex(params.package_name)
      case "lookup":
        return docsLookup(params.symbol, params.package_name)
      case "search":
        return docsSearch(params.query, params.max_results)
      case "stats":
        return docsStats()
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
})

async function docsIndex(packageName?: string) {
  if (!packageName) throw new Error("package_name is required for index")
  const cwd = Instance.directory
  const count = await Docs.indexPackage(packageName, cwd)
  const stats = Docs.stats()
  return {
    title: `docs: indexed ${packageName} (${count} symbols)`,
    metadata: { truncated: false, packageName, newSymbols: count, totalSymbols: stats.symbols },
    output: count > 0
      ? `Indexed ${count} new symbol(s) from ${packageName}. Total: ${stats.symbols} symbol(s) across ${stats.packages} package(s).`
      : `Package ${packageName} already indexed (or not found). Total: ${stats.symbols} symbol(s) across ${stats.packages} package(s).`,
  }
}

function docsLookup(symbol?: string, packageName?: string) {
  if (!symbol) throw new Error("symbol is required for lookup")
  const results = Docs.lookup(symbol, packageName)
  return {
    title: `docs: lookup ${symbol} (${results.length} result(s))`,
    metadata: { truncated: false, symbol, resultCount: results.length },
    output: Docs.format(results),
  }
}

function docsSearch(query?: string, maxResults?: number) {
  if (!query) throw new Error("query is required for search")
  const results = Docs.search(query, maxResults ?? 10)
  return {
    title: `docs: search "${query}" (${results.length} result(s))`,
    metadata: { truncated: false, query, resultCount: results.length },
    output: Docs.format(results, 2000),
  }
}

function docsStats() {
  const stats = Docs.stats()
  return {
    title: "docs: stats",
    metadata: { truncated: false, ...stats },
    output: `Documentation index: ${stats.packages} package(s), ${stats.symbols} symbol(s).`,
  }
}
