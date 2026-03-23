import { Database, eq } from "@/storage/db"
import { GraphNodeTable } from "@/graph/schema.sql"
import { EmbeddingProvider } from "./provider"
import { EmbeddingStore } from "./store"
import { RAG } from "./rag"
import { Log } from "@/util/log"
import { createHash } from "crypto"
import type { Scorer } from "@/context/scorer"

/**
 * Semantic code search — query your codebase using natural language.
 *
 * Embeds the query, computes cosine similarity against stored code
 * embeddings, and returns ranked results. Integrates with the context
 * pipeline as a post-scorer reranking step.
 */
export namespace SemanticSearch {
  const log = Log.create({ service: "embedding.search" })

  /** Search result combining vector similarity with graph node info. */
  export interface Result {
    /** Graph node ID. */
    nodeID: string
    /** File path of the matched entity. */
    filePath: string
    /** Symbol name. */
    name: string
    /** Entity kind (function, class, etc.). */
    kind: string
    /** Cosine similarity score (0-1). */
    similarity: number
    /** Signature if available. */
    signature?: string | null
    /** Start line in the file. */
    startLine: number
    /** End line in the file. */
    endLine: number
  }

  /**
   * Search the codebase semantically using a natural language query.
   *
   * Embeds the query text, finds the most similar code entities,
   * and enriches results with graph node metadata.
   *
   * @param query - Natural language query (e.g. "error handling middleware")
   * @param projectID - Project to search within
   * @param topK - Number of results to return (default: 20)
   * @param minSimilarity - Minimum cosine similarity threshold (default: 0.3)
   * @returns Array of search results sorted by similarity
   */
  export async function search(
    query: string,
    projectID: string,
    topK: number = 20,
    minSimilarity: number = 0.3,
  ): Promise<Result[]> {
    const config = await EmbeddingProvider.getConfig()

    // Check query embedding cache
    const queryHash = hashQuery(query)
    let queryVec = EmbeddingStore.getCachedQuery(queryHash, config.model)

    if (!queryVec) {
      // Embed the query
      try {
        queryVec = await EmbeddingProvider.embedOne(query, config)
        EmbeddingStore.cacheQuery(queryHash, query, queryVec, config.model)
      } catch (err: any) {
        log.error("failed to embed query", { error: err.message })
        return []
      }
    }

    // Find similar vectors
    const matches = EmbeddingStore.search(queryVec, projectID, topK, minSimilarity)

    if (matches.length === 0) return []

    // Enrich with graph node metadata
    const nodeIDs = matches.map((m) => m.nodeID)
    const nodeMap = getNodeMetadata(projectID, nodeIDs)

    const results: Result[] = []
    for (const match of matches) {
      const node = nodeMap.get(match.nodeID)
      if (!node) continue

      results.push({
        nodeID: match.nodeID,
        filePath: node.filePath,
        name: node.name,
        kind: node.kind,
        similarity: match.similarity,
        signature: node.signature,
        startLine: node.startLine,
        endLine: node.endLine,
      })
    }

    log.info("semantic search complete", {
      query: query.slice(0, 100),
      results: results.length,
      topSimilarity: results[0]?.similarity,
    })

    return results
  }

  /**
   * Rerank scored candidates from the context pipeline using semantic similarity.
   *
   * Blends traditional scores (name match, graph centrality, etc.) with
   * cosine similarity to the user's query. This is Stage 3b of the pipeline.
   *
   * @param queryText - User's message text
   * @param candidates - Candidates already scored by the traditional pipeline
   * @param semanticWeight - How much to blend semantic scores (0-1, default: 0.3)
   * @param projectID - Project ID for embedding lookup
   * @returns Re-scored candidates with blended scores
   */
  export async function rerank(
    queryText: string,
    candidates: Scorer.ScoredCandidate[],
    semanticWeight: number,
    projectID: string,
  ): Promise<Scorer.ScoredCandidate[]> {
    if (candidates.length === 0 || semanticWeight <= 0) return candidates

    const config = await EmbeddingProvider.getConfig()

    // Embed the query (with caching)
    const queryHash = hashQuery(queryText)
    let queryVec = EmbeddingStore.getCachedQuery(queryHash, config.model)

    if (!queryVec) {
      try {
        queryVec = await EmbeddingProvider.embedOne(queryText, config)
        EmbeddingStore.cacheQuery(queryHash, queryText, queryVec, config.model)
      } catch (err: any) {
        log.warn("semantic rerank failed — returning original scores", { error: err.message })
        return candidates
      }
    }

    // Build a map of nodeID → semantic similarity
    // We need to identify which candidates have embeddings
    const candidateIDs = new Set<string>()
    for (const c of candidates) {
      // Candidate ID format from scorer: file_path:name:startLine
      // We need to match against graph node IDs
      if ((c as any).nodeID) {
        candidateIDs.add((c as any).nodeID)
      }
    }

    // Get all embeddings for the project and compute similarities
    const allMatches = EmbeddingStore.search(queryVec, projectID, candidates.length * 2, 0)
    const similarityMap = new Map<string, number>()
    for (const match of allMatches) {
      similarityMap.set(match.nodeID, match.similarity)
    }

    // Also build a lookup by filePath+name for matching candidates without nodeID
    const nodeMetaMap = new Map<string, string>() // "filePath:name" → nodeID
    if (allMatches.length > 0) {
      const nodeIDs = allMatches.map((m) => m.nodeID)
      const meta = getNodeMetadata(projectID, nodeIDs)
      for (const [nodeID, node] of meta) {
        nodeMetaMap.set(`${node.filePath}:${node.name}`, nodeID)
      }
    }

    // Also check RAG index for file-level similarity boost
    const ragFileScores = new Map<string, number>()
    try {
      const ragConfigured = await RAG.isConfigured()
      if (ragConfigured) {
        const ragResults = await RAG.search(queryText, 20, 0.3)
        for (const r of ragResults) {
          const existing = ragFileScores.get(r.filePath) ?? 0
          ragFileScores.set(r.filePath, Math.max(existing, r.similarity))
        }
      }
    } catch {
      // RAG search failed — continue without it
    }

    // Blend scores: combine graph embedding similarity + RAG file-level boost
    const ragBoostWeight = 0.1 // RAG contributes up to 10% of the final score
    const reranked = candidates.map((c) => {
      // Try to find semantic score via nodeID or filePath:name
      let semanticScore = 0
      const lookupKey = `${c.filePath}:${c.name ?? ""}`
      const matchedNodeID = nodeMetaMap.get(lookupKey)
      if (matchedNodeID) {
        semanticScore = similarityMap.get(matchedNodeID) ?? 0
      }

      // RAG file-level boost: if the candidate's file has RAG hits, boost it
      const ragScore = ragFileScores.get(c.filePath) ?? 0

      const blendedScore =
        c.score * (1 - semanticWeight - ragBoostWeight) +
        semanticScore * semanticWeight +
        ragScore * ragBoostWeight

      return { ...c, score: blendedScore }
    })

    // Re-sort by blended score
    reranked.sort((a, b) => b.score - a.score)

    log.info("semantic rerank complete", {
      candidates: candidates.length,
      withEmbeddings: allMatches.length,
      semanticWeight,
    })

    return reranked
  }

  /**
   * Check if the embedding index is available for a project.
   *
   * @param projectID - Project ID
   * @returns true if embeddings exist and provider is reachable
   */
  export async function isAvailable(projectID: string): Promise<boolean> {
    const stats = EmbeddingStore.stats(projectID)
    if (stats.count === 0) return false
    return EmbeddingProvider.isAvailable()
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Hash a query string for cache lookup.
   *
   * @param query - Query text
   * @returns SHA-256 hex hash
   */
  function hashQuery(query: string): string {
    return createHash("sha256").update(query.trim().toLowerCase()).digest("hex")
  }

  /**
   * Get graph node metadata for a set of node IDs.
   *
   * @param projectID - Project ID
   * @param nodeIDs - Array of node IDs to look up
   * @returns Map of nodeID to node metadata
   */
  function getNodeMetadata(
    projectID: string,
    nodeIDs: string[],
  ): Map<
    string,
    {
      filePath: string
      name: string
      kind: string
      signature: string | null
      startLine: number
      endLine: number
    }
  > {
    const map = new Map<
      string,
      {
        filePath: string
        name: string
        kind: string
        signature: string | null
        startLine: number
        endLine: number
      }
    >()

    Database.use((db) => {
      for (const nodeID of nodeIDs) {
        const row = db
          .select({
            id: GraphNodeTable.id,
            filePath: GraphNodeTable.file_path,
            name: GraphNodeTable.name,
            kind: GraphNodeTable.kind,
            signature: GraphNodeTable.signature,
            startLine: GraphNodeTable.start_line,
            endLine: GraphNodeTable.end_line,
          })
          .from(GraphNodeTable)
          .where(eq(GraphNodeTable.id, nodeID))
          .get()

        if (row) {
          map.set(nodeID, {
            filePath: row.filePath,
            name: row.name,
            kind: row.kind,
            signature: row.signature,
            startLine: row.startLine,
            endLine: row.endLine,
          })
        }
      }
    })

    return map
  }
}
