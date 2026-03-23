import z from "zod"
import { Tool } from "./tool"
import { SemanticSearch, EmbeddingIndexer, EmbeddingStore, EmbeddingProvider, RAG } from "../embedding"
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
provider is available. RAG indexing runs automatically on startup when sources are
configured. Semantic similarity is also blended into the context pipeline.

Operations:
- search: Find code entities similar to a natural language query (searches both graph and RAG)
- index: Manually rebuild the graph embedding index (normally automatic)
- rag_index: Manually rebuild the RAG document index (crawl configured directories)
- rag_status: Show RAG index statistics (files, chunks, coverage)
- status: Show embedding index statistics and provider status

Unlike grep/glob which match text patterns, semantic search understands intent:
- "error handling middleware" finds error handlers even if not named "error"
- "database connection pooling" finds connection management code
- "authentication flow" finds auth-related functions across the codebase

Requires an embedding provider (e.g. ollama with nomic-embed-text).
Configure in opencode.jsonc under "embedding" key.
For RAG, add "sources" array to the embedding config to specify directories to index.`,
  parameters: z.object({
    operation: z
      .enum(["search", "index", "rag_index", "rag_status", "status"])
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
      case "rag_index":
        return ragIndex()
      case "rag_status":
        return ragStatus()
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

  // Also search RAG index if configured
  let ragResults: RAG.SearchResult[] = []
  try {
    const ragConfigured = await RAG.isConfigured()
    if (ragConfigured) {
      ragResults = await RAG.search(query, k, 0.3)
    }
  } catch {
    // RAG search failed — continue with graph results only
  }

  const lines: string[] = []
  const totalResults = results.length + ragResults.length
  lines.push(`Found ${totalResults} result(s) for: "${query}"\n`)

  if (results.length > 0) {
    lines.push("── Graph Results ──")
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const sim = (r.similarity * 100).toFixed(1)
      const sig = r.signature ? ` — ${r.signature}` : ""
      lines.push(`${i + 1}. [${sim}%] ${r.filePath}:${r.startLine} (${r.kind}) ${r.name}${sig}`)
    }
  }

  if (ragResults.length > 0) {
    if (results.length > 0) lines.push("")
    lines.push("── RAG Results ──")
    for (let i = 0; i < ragResults.length; i++) {
      const r = ragResults[i]
      const sim = (r.similarity * 100).toFixed(1)
      lines.push(`${results.length + i + 1}. [${sim}%] ${r.filePath}:${r.startLine}-${r.endLine}`)
    }
  }

  return {
    title: `semantic_search: ${totalResults} results`,
    metadata: {
      query,
      results: results.length,
      ragResults: ragResults.length,
      topSimilarity: results[0]?.similarity ?? ragResults[0]?.similarity,
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

  // Include RAG status
  const ragConfigured = await RAG.isConfigured()
  if (ragConfigured) {
    const ragStats = RAG.stats()
    sections.push("")
    sections.push("── RAG Index ──")
    sections.push(`RAG files:    ${ragStats.totalFiles}`)
    sections.push(`RAG chunks:   ${ragStats.totalChunks}`)
    if (ragStats.embeddingStats.model) {
      sections.push(`RAG model:    ${ragStats.embeddingStats.model}`)
    }
  }

  return {
    title: "semantic_search: status",
    metadata: {
      available,
      embeddedCount: embeddingStats.count,
      graphNodes: graphStats.nodeCount,
      model: config.model,
      baseURL: config.baseURL,
      ragConfigured,
    },
    output: sections.join("\n"),
  }
}

/**
 * Build or update the RAG document index.
 *
 * Crawls configured source directories, chunks files, embeds, and stores.
 *
 * @returns Tool result with RAG indexing statistics
 */
async function ragIndex(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const config = await RAG.getConfig()
  if (config.sources.length === 0) {
    return {
      title: "semantic_search: no RAG sources",
      metadata: { configured: false },
      output: `No RAG sources configured.\n\nAdd source directories to your opencode.jsonc:\n  "embedding": {\n    "sources": ["~/projects", "~/docs"]\n  }`,
    }
  }

  const providerConfig = await EmbeddingProvider.getConfig()
  const available = await EmbeddingProvider.isAvailable(providerConfig)
  if (!available) {
    return {
      title: "semantic_search: provider unavailable",
      metadata: { baseURL: providerConfig.baseURL, model: providerConfig.model },
      output: `Embedding provider not available at ${providerConfig.baseURL} (model: ${providerConfig.model}).\n\nTo set up:\n1. Install ollama: curl -fsSL https://ollama.ai/install.sh | sh\n2. Pull an embedding model: ollama pull nomic-embed-text`,
    }
  }

  const result = await RAG.index(config, providerConfig)

  const sections: string[] = []
  sections.push(`RAG index ${result.changedFiles > 0 ? "updated" : "is up to date"}.\n`)
  sections.push(`Total files:     ${result.totalFiles}`)
  sections.push(`Changed files:   ${result.changedFiles}`)
  sections.push(`Skipped:         ${result.skippedFiles}`)
  sections.push(`Chunks created:  ${result.chunksGenerated}`)
  sections.push(`Chunks embedded: ${result.chunksEmbedded}`)
  if (result.pruned > 0) {
    sections.push(`Pruned (stale):  ${result.pruned}`)
  }
  if (result.errors > 0) {
    sections.push(`Errors:          ${result.errors}`)
  }
  sections.push(`Duration:        ${(result.durationMs / 1000).toFixed(1)}s`)
  sections.push(`\nModel: ${providerConfig.model} @ ${providerConfig.baseURL}`)

  return {
    title: `semantic_search: RAG indexed ${result.changedFiles} files`,
    metadata: result,
    output: sections.join("\n"),
  }
}

/**
 * Show RAG index statistics.
 *
 * @returns Tool result with RAG status
 */
async function ragStatus(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const config = await RAG.getConfig()
  const ragStats = RAG.stats()

  const sections: string[] = []
  sections.push("RAG Index Status\n")

  if (config.sources.length === 0) {
    sections.push("Sources:      (none configured)")
    sections.push("")
    sections.push('Add source directories to your opencode.jsonc under "embedding.sources".')
  } else {
    sections.push(`Sources:      ${config.sources.join(", ")}`)
    sections.push(`Excludes:     ${config.exclude.length} patterns`)
    sections.push(`Extensions:   ${config.extensions.length} types`)
    sections.push(`Chunk size:   ${config.chunkSize} chars (overlap: ${config.chunkOverlap})`)
    sections.push("")
    sections.push(`Indexed files: ${ragStats.totalFiles}`)
    sections.push(`Total chunks:  ${ragStats.totalChunks}`)
    sections.push(`Embeddings:    ${ragStats.embeddingStats.count}`)
    if (ragStats.embeddingStats.model) {
      sections.push(`Model:         ${ragStats.embeddingStats.model}`)
    }
    if (ragStats.embeddingStats.dimension) {
      sections.push(`Dimension:     ${ragStats.embeddingStats.dimension}`)
    }
  }

  return {
    title: "semantic_search: RAG status",
    metadata: {
      sources: config.sources,
      totalFiles: ragStats.totalFiles,
      totalChunks: ragStats.totalChunks,
      configured: config.sources.length > 0,
    },
    output: sections.join("\n"),
  }
}
