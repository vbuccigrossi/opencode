import { Scorer } from "./scorer"
import { Packer } from "./packer"
import { Graph } from "@/graph"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { SemanticSearch } from "@/embedding/search"
import { EmbeddingStore } from "@/embedding/store"
import { RAG } from "@/embedding/rag"
import { RAGFormatter } from "@/embedding/format"
import { Token } from "@/util/token"
import { readFileSync } from "fs"

/**
 * Multi-stage relevance pipeline for intelligent context selection.
 *
 * Replaces naive "send whole files" with a 4-stage pipeline:
 *   1. Candidate Discovery — parse user request, query graph, find matches
 *   2. Structural Expansion — expand via graph neighbors (callers, callees, tests)
 *   3. Importance Scoring — combine signals into a composite score
 *   4. Context Packing — extract relevant snippets within token budget
 *
 * The pipeline runs on each user message before the LLM call, injecting
 * high-signal code context into the system prompt.
 */
export namespace ContextPipeline {
  const log = Log.create({ service: "context.pipeline" })

  /** Pipeline configuration. */
  export interface Config {
    /** Maximum tokens for context block (default: 6000) */
    maxTokens: number
    /** Minimum score threshold for inclusion (default: 0.05) */
    minScore: number
    /** Maximum candidates to consider (default: 100) */
    maxCandidates: number
    /** Whether to include structural annotations (default: true) */
    annotations: boolean
    /** Whether to include signature-only entries (default: true) */
    signatures: boolean
    /** Custom signal weights */
    weights?: Scorer.Weights
    /** Semantic reranking weight (0-1). 0 = disabled, 0.3 = default when embeddings exist */
    semanticWeight?: number
    /** Maximum tokens to allocate for RAG context (default: 2000) */
    ragMaxTokens?: number
  }

  const DEFAULT_CONFIG: Config = {
    maxTokens: 6000,
    minScore: 0.05,
    maxCandidates: 100,
    annotations: true,
    signatures: true,
  }

  /** Result of running the pipeline. */
  export interface Result {
    /** The formatted context block to inject into the system prompt */
    contextBlock: string
    /** RAG document context block (empty string if no RAG results) */
    ragContextBlock: string
    /** Number of candidates scored */
    candidatesScored: number
    /** Number of entries packed into context */
    entriesPacked: number
    /** Total tokens used by context */
    tokensUsed: number
    /** Number of RAG chunks included */
    ragChunks: number
    /** How long the pipeline took in ms */
    durationMs: number
  }

  /**
   * Runs the full context pipeline for a user message.
   *
   * @param userText - The text content of the user's message
   * @param projectID - Project identifier for graph queries
   * @param recentFiles - Files recently read/edited by the user in this session
   * @param config - Optional pipeline configuration
   * @returns Pipeline result with the context block to inject
   */
  export async function run(
    userText: string,
    projectID: string,
    recentFiles: string[],
    config: Partial<Config> = {},
  ): Promise<Result> {
    const start = Date.now()
    const cfg = { ...DEFAULT_CONFIG, ...config }

    // Stage 5 (parallel): RAG context retrieval — runs alongside graph pipeline
    const ragPromise = fetchRAGContext(userText, cfg.ragMaxTokens ?? 2000)

    // Check if graph has any data — skip if not indexed
    const graphStats = Graph.stats(projectID)
    if (graphStats.nodeCount === 0) {
      const ragResult = await ragPromise
      return {
        contextBlock: "",
        ragContextBlock: ragResult.text,
        candidatesScored: 0,
        entriesPacked: 0,
        tokensUsed: ragResult.tokens,
        ragChunks: ragResult.chunks,
        durationMs: Date.now() - start,
      }
    }

    // Stage 1 + 2: Extract seeds from user message
    const seeds = Scorer.extractSeeds(userText)

    // If no seeds extracted, skip — the user's message doesn't reference code
    if (seeds.keywords.length === 0 && seeds.filePaths.length === 0) {
      const ragResult = await ragPromise
      return {
        contextBlock: "",
        ragContextBlock: ragResult.text,
        candidatesScored: 0,
        entriesPacked: 0,
        tokensUsed: ragResult.tokens,
        ragChunks: ragResult.chunks,
        durationMs: Date.now() - start,
      }
    }

    // Stage 3: Score all candidates
    const directory = Instance.worktree
    const candidates = await Scorer.score(
      projectID,
      directory,
      seeds,
      recentFiles,
      cfg.weights,
    )

    // Stage 3b: Semantic reranking (if embeddings exist)
    let reranked = candidates
    const embeddingStats = EmbeddingStore.stats(projectID)
    if (embeddingStats.count > 0) {
      const semanticWeight = cfg.semanticWeight ?? 0.3
      if (semanticWeight > 0) {
        try {
          reranked = await SemanticSearch.rerank(userText, candidates, semanticWeight, projectID)
          log.info("semantic rerank applied", {
            candidates: candidates.length,
            semanticWeight,
            embeddedNodes: embeddingStats.count,
          })
        } catch (err: any) {
          log.warn("semantic rerank failed, using traditional scores", { error: err.message })
        }
      }
    }

    // Filter by minimum score and limit count
    const filtered = reranked
      .filter((c) => c.score >= cfg.minScore)
      .slice(0, cfg.maxCandidates)

    // Wait for RAG results
    const ragResult = await ragPromise

    if (filtered.length === 0) {
      return {
        contextBlock: "",
        ragContextBlock: ragResult.text,
        candidatesScored: candidates.length,
        entriesPacked: 0,
        tokensUsed: ragResult.tokens,
        ragChunks: ragResult.chunks,
        durationMs: Date.now() - start,
      }
    }

    // Stage 4: Pack into context block
    const packed = Packer.pack(filtered, projectID, {
      maxTokens: cfg.maxTokens,
      annotations: cfg.annotations,
      signatures: cfg.signatures,
    })

    log.info("context pipeline complete", {
      seedKeywords: seeds.keywords.length,
      seedFiles: seeds.filePaths.length,
      candidatesScored: candidates.length,
      entriesPacked: packed.entries.length,
      tokensUsed: packed.totalTokens,
      ragChunks: ragResult.chunks,
      dropped: packed.dropped,
      durationMs: Date.now() - start,
    })

    return {
      contextBlock: packed.text,
      ragContextBlock: ragResult.text,
      candidatesScored: candidates.length,
      entriesPacked: packed.entries.length,
      tokensUsed: packed.totalTokens + ragResult.tokens,
      ragChunks: ragResult.chunks,
      durationMs: Date.now() - start,
    }
  }

  /**
   * Fetch relevant RAG document chunks for a user query.
   *
   * Searches the RAG index, reads the actual file content for each hit,
   * and formats it into a context block within a token budget.
   *
   * @param userText - User's query text
   * @param maxTokens - Maximum token budget for RAG context
   * @returns RAG context block with text, token count, and chunk count
   */
  async function fetchRAGContext(
    userText: string,
    maxTokens: number,
  ): Promise<{ text: string; tokens: number; chunks: number }> {
    try {
      const configured = await RAG.isConfigured()
      if (!configured) return { text: "", tokens: 0, chunks: 0 }

      // Hybrid search: vector + FTS keyword + query expansion
      const results = await RAG.search(userText, 15, 0.25)
      if (results.length === 0) return { text: "", tokens: 0, chunks: 0 }

      // Use enhanced formatter that groups by category and includes metadata
      const text = RAGFormatter.formatResults(results, maxTokens)
      if (!text) return { text: "", tokens: 0, chunks: 0 }

      const finalTokens = Token.estimate(text)

      log.info("RAG context fetched", {
        results: results.length,
        tokens: finalTokens,
      })

      return { text, tokens: finalTokens, chunks: results.length }
    } catch (err: any) {
      log.warn("RAG context fetch failed", { error: err.message })
      return { text: "", tokens: 0, chunks: 0 }
    }
  }

  /**
   * Extracts recent files from session message history.
   *
   * Looks at recent tool calls (read, edit, write) to find files
   * the user has been working with.
   *
   * @param parts - Message parts from recent session history
   * @returns Array of relative file paths
   */
  export function extractRecentFiles(parts: Array<{ type: string; tool?: string; input?: unknown }>): string[] {
    const files = new Set<string>()

    for (const part of parts) {
      if (part.type !== "tool" || !part.input) continue
      const input = part.input as Record<string, unknown>

      switch (part.tool) {
        case "read":
        case "edit":
        case "write":
          if (typeof input.file_path === "string") {
            files.add(input.file_path)
          }
          break
        case "grep":
        case "glob":
          // These don't give us specific files the user cares about
          break
      }
    }

    return [...files]
  }
}
