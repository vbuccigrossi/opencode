import z from "zod"
import { Tool } from "./tool"
import { Research } from "../research"
import { Log } from "../util/log"

/**
 * Web research tool — structured research for error lookups, package documentation,
 * changelogs, library comparisons, and code snippet searches.
 *
 * Builds on package registries and search engines to provide structured results.
 */
export const ResearchTool = Tool.define("research", async () => ({
  description: `Perform structured web research with focused results.

Operations:
- docs: Look up documentation for a package from its registry (npm, pypi, crates, go). Returns version, description, homepage, repository, keywords, and README excerpt.
- error_lookup: Given an error message or code, build search URLs for StackOverflow, GitHub issues, and language-specific error references (TypeScript TS errors, Rust E errors).
- changelog: Get changelog URLs for a package.
- compare: Build comparison queries and URLs for two libraries (npmtrends, StackOverflow).
- snippet: Search for code examples of a specific API or function.

For raw URL fetching, use the webfetch tool. For general web search, use the websearch tool.
This tool provides higher-level, structured research operations.`,
  parameters: z.object({
    operation: z
      .enum(["docs", "error_lookup", "changelog", "compare", "snippet"])
      .describe("The research operation to perform"),
    package_name: z.string().optional().describe("Package name (for docs, changelog)"),
    registry: z
      .enum(["npm", "pypi", "crates", "go"])
      .optional()
      .describe("Package registry (for docs, changelog; default: npm)"),
    error: z.string().optional().describe("Error message or code (for error_lookup)"),
    context: z.string().optional().describe("Additional context like language or framework (for error_lookup, compare)"),
    lib1: z.string().optional().describe("First library (for compare)"),
    lib2: z.string().optional().describe("Second library (for compare)"),
    api: z.string().optional().describe("API or function name (for snippet)"),
    language: z.string().optional().describe("Programming language (for snippet)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "docs":
        return researchDocs(params.package_name, params.registry)
      case "error_lookup":
        return researchErrorLookup(params.error, params.context)
      case "changelog":
        return researchChangelog(params.package_name, params.registry)
      case "compare":
        return researchCompare(params.lib1, params.lib2, params.context)
      case "snippet":
        return researchSnippet(params.api, params.language)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.research" })

async function researchDocs(
  packageName?: string,
  registry?: "npm" | "pypi" | "crates" | "go",
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!packageName) throw new Error("package_name is required for docs operation")

  const doc = await Research.docs(packageName, registry ?? "npm")
  return {
    title: `research: docs ${packageName}${doc.version ? ` v${doc.version}` : ""}`,
    metadata: { package: packageName, version: doc.version, registry: registry ?? "npm" },
    output: Research.formatDoc(doc),
  }
}

function researchErrorLookup(
  error?: string,
  context?: string,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!error) throw new Error("error parameter is required for error_lookup")

  const result = Research.errorLookup(error, context)
  const lines = [
    `Search query: ${result.query}`,
    "",
    "URLs to investigate:",
    ...result.urls.map((url, i) => `${i + 1}. ${url}`),
  ]

  return Promise.resolve({
    title: `research: error lookup`,
    metadata: { query: result.query, urlCount: result.urls.length },
    output: lines.join("\n"),
  })
}

function researchChangelog(
  packageName?: string,
  registry?: "npm" | "pypi" | "crates" | "go",
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!packageName) throw new Error("package_name is required for changelog operation")

  const reg = registry === "go" ? "npm" : (registry ?? "npm")
  const urls = Research.changelogUrl(packageName, reg as "npm" | "pypi" | "crates")
  const lines = [
    `Changelog URLs for ${packageName}:`,
    "",
    ...urls.map((url, i) => `${i + 1}. ${url}`),
  ]

  return Promise.resolve({
    title: `research: changelog ${packageName}`,
    metadata: { package: packageName, registry: reg, urlCount: urls.length },
    output: lines.join("\n"),
  })
}

function researchCompare(
  lib1?: string,
  lib2?: string,
  context?: string,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!lib1 || !lib2) throw new Error("lib1 and lib2 are required for compare operation")

  const result = Research.compare(lib1, lib2, context)
  const lines = [
    `Comparison: ${result.query}`,
    "",
    "URLs to investigate:",
    ...result.urls.map((url, i) => `${i + 1}. ${url}`),
  ]

  return Promise.resolve({
    title: `research: ${lib1} vs ${lib2}`,
    metadata: { lib1, lib2, query: result.query },
    output: lines.join("\n"),
  })
}

function researchSnippet(
  api?: string,
  language?: string,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!api) throw new Error("api parameter is required for snippet operation")

  const result = Research.snippetSearch(api, language)
  const lines = [
    `Code search: ${result.query}`,
    "",
    "URLs to search:",
    ...result.urls.map((url, i) => `${i + 1}. ${url}`),
  ]

  return Promise.resolve({
    title: `research: snippet ${api}`,
    metadata: { api, language, query: result.query },
    output: lines.join("\n"),
  })
}
