import z from "zod"
import { Tool } from "./tool"
import { SemanticSearch, EmbeddingIndexer, EmbeddingStore, EmbeddingProvider } from "../embedding"
import { Instance } from "../project/instance"
import { Graph } from "../graph"
import { Log } from "../util/log"

/**
 * Semantic search tool — find code by meaning, not just keywords.
 *
 * Uses vector embeddings to understand what code does, not just
 * what it's named. Powered by a local embedding model (ollama)
 * and SQLite-backed vector storage.
 */
export const SemanticSearchTool = Tool.define("semantic_search", async () => ({
  description: `Search your codebase semantically — find code by meaning, not just keywords.

The embedding index is built automatically after each graph build when an embedding
provider is available. Semantic similarity is also automatically blended into the
context pipeline, so relevant code is surfaced without explicit searches.

Operations:
- search: Find code entities similar to a natural language query
- index: Manually rebuild the embedding index (normally automatic)
- status: Show embedding index statistics and provider status

Unlike grep/glob which match text patterns, semantic search understands intent:
- "error handling middleware" finds error handlers even if not named "error"
- "database connection pooling" finds connection management code
- "authentication flow" finds auth-related functions across the codebase

Requires an embedding provider (e.g. ollama with nomic-embed-text).
Configure in opencode.jsonc under "embedding" key.`,
  parameters: z.object({
    operation: z
      .enum(["search", "index", "status"])
      .describe("The operation to perform"),
    query: z
      .string()
      .optional()
      .describe("Natural language search query (required for search)"),
    top_k: z
      .number()
      .optional()
      .describe("Number of results to return (default: 20, max: 50)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "search":
        return semanticSearch(params.query, params.top_k)
      case "index":
        return semanticIndex()
      case "status":
        return semanticStatus()
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.semantic_search" })

/**
 * Perform a semantic code search.
 *
 * @param query - Natural language query
 * @param topK - Number of results
 * @returns Tool result with search results
 */
async function semanticSearch(
  query?: string,
  topK?: number,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!query) throw new Error("query parameter is required for search operation")

  const projectID = Instance.project.id
  const k = Math.min(topK ?? 20, 50)

  // Check if index exists
  const stats = EmbeddingStore.stats(projectID)
  if (stats.count === 0) {
    return {
      title: "semantic_search: no index",
      metadata: { indexed: false },
      output: `No embedding index found for this project.\n\nRun semantic_search with operation "index" first to build the embedding index.\nThis requires an embedding provider (e.g. ollama with nomic-embed-text model).`,
    }
  }

  const results = await SemanticSearch.search(query, projectID, k)

  if (results.length === 0) {
    return {
      title: `semantic_search: "${query.slice(0, 40)}"`,
      metadata: { results: 0, query },
      output: `No results found for: "${query}"\n\nTry a different query or re-index if the codebase has changed.`,
    }
  }

  const lines: string[] = []
  lines.push(`Found ${results.length} result(s) for: "${query}"\n`)

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const sim = (r.similarity * 100).toFixed(1)
    const sig = r.signature ? ` — ${r.signature}` : ""
    lines.push(`${i + 1}. [${sim}%] ${r.filePath}:${r.startLine} (${r.kind}) ${r.name}${sig}`)
  }

  return {
    title: `semantic_search: ${results.length} results`,
    metadata: {
      query,
      results: results.length,
      topSimilarity: results[0]?.similarity,
      topResult: results[0]?.name,
    },
    output: lines.join("\n"),
  }
}

/**
 * Build or update the embedding index.
 *
 * @returns Tool result with indexing statistics
 */
async function semanticIndex(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const projectID = Instance.project.id
  const directory = Instance.worktree

  // Check graph has data
  const graphStats = Graph.stats(projectID)
  if (graphStats.nodeCount === 0) {
    return {
      title: "semantic_search: no graph",
      metadata: { graphNodes: 0 },
      output: `No code graph found. The graph needs to be built first (it's built automatically when you start working with code).\n\nTry reading or editing some files first, then run index again.`,
    }
  }

  // Check provider
  const config = await EmbeddingProvider.getConfig()
  const available = await EmbeddingProvider.isAvailable(config)
  if (!available) {
    return {
      title: "semantic_search: provider unavailable",
      metadata: { baseURL: config.baseURL, model: config.model },
      output: `Embedding provider not available at ${config.baseURL} (model: ${config.model}).\n\nTo set up:\n1. Install ollama: curl -fsSL https://ollama.ai/install.sh | sh\n2. Pull an embedding model: ollama pull nomic-embed-text\n3. Ollama auto-serves on localhost:11434\n\nOr configure a custom provider in opencode.jsonc:\n  "embedding": { "baseURL": "http://...", "model": "..." }`,
    }
  }

  const result = await EmbeddingIndexer.index(projectID, directory, config)

  const sections: string[] = []
  sections.push(`Embedding index ${result.indexed > 0 ? "updated" : "is up to date"}.\n`)
  sections.push(`Total graph nodes: ${result.totalNodes}`)
  sections.push(`Indexed (new):     ${result.indexed}`)
  sections.push(`Updated:           ${result.updated}`)
  sections.push(`Skipped (cached):  ${result.skipped}`)
  sections.push(`Pruned (stale):    ${result.pruned}`)
  if (result.errors > 0) {
    sections.push(`Errors:            ${result.errors}`)
  }
  sections.push(`Duration:          ${(result.durationMs / 1000).toFixed(1)}s`)
  sections.push(`\nModel: ${config.model} @ ${config.baseURL}`)

  return {
    title: `semantic_search: indexed ${result.indexed} nodes`,
    metadata: result,
    output: sections.join("\n"),
  }
}

/**
 * Show embedding index status and provider info.
 *
 * @returns Tool result with status information
 */
async function semanticStatus(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const projectID = Instance.project.id
  const config = await EmbeddingProvider.getConfig()

  const embeddingStats = EmbeddingStore.stats(projectID)
  const graphStats = Graph.stats(projectID)
  const available = await EmbeddingProvider.isAvailable(config)

  const sections: string[] = []
  sections.push("Embedding Index Status\n")

  sections.push(`Provider:     ${config.baseURL}`)
  sections.push(`Model:        ${config.model}`)
  sections.push(`Available:    ${available ? "yes" : "NO — provider not reachable"}`)
  sections.push("")

  sections.push(`Graph nodes:  ${graphStats.nodeCount}`)
  sections.push(`Embedded:     ${embeddingStats.count}`)

  if (graphStats.nodeCount > 0) {
    const coverage = ((embeddingStats.count / graphStats.nodeCount) * 100).toFixed(1)
    sections.push(`Coverage:     ${coverage}%`)
  }

  if (embeddingStats.dimension) {
    sections.push(`Dimension:    ${embeddingStats.dimension}`)
  }
  if (embeddingStats.model) {
    sections.push(`Stored model: ${embeddingStats.model}`)
  }

  if (!available) {
    sections.push("")
    sections.push("To set up embedding provider:")
    sections.push("  1. Install ollama: curl -fsSL https://ollama.ai/install.sh | sh")
    sections.push("  2. Pull model: ollama pull nomic-embed-text")
    sections.push("  3. Run index: semantic_search index")
  } else if (embeddingStats.count === 0 && graphStats.nodeCount > 0) {
    sections.push("")
    sections.push('Run semantic_search with operation "index" to build the embedding index.')
  }

  return {
    title: "semantic_search: status",
    metadata: {
      available,
      embeddedCount: embeddingStats.count,
      graphNodes: graphStats.nodeCount,
      model: config.model,
      baseURL: config.baseURL,
    },
    output: sections.join("\n"),
  }
}
