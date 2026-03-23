import { createHash } from "crypto"
import { Log } from "@/util/log"
import { Crawler } from "./crawler"
import { Chunker } from "./chunker"
import { EmbeddingProvider } from "./provider"
import { EmbeddingStore } from "./store"
import { FTS } from "./fts"
import { QueryExpand } from "./query-expand"
import { MetadataExtract } from "./metadata-extract"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import path from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"

/**
 * Full RAG indexer — crawl directories, chunk files, embed, store.
 *
 * Orchestrates the complete pipeline:
 *   1. Crawl configured source directories
 *   2. Check for changed files (incremental by mtime)
 *   3. Chunk changed files into embedding-ready segments
 *   4. Generate embeddings via the configured provider
 *   5. Store in SQLite for retrieval
 *
 * State is tracked in a manifest file to enable incremental updates.
 */
export namespace RAG {
  const log = Log.create({ service: "embedding.rag" })

  /** RAG configuration (from opencode.jsonc embedding section). */
  export interface Config {
    /** Directories to index. */
    sources: string[]
    /** Directory names to exclude. */
    exclude: string[]
    /** File extensions to include. */
    extensions: string[]
    /** Chunk size in characters. */
    chunkSize: number
    /** Chunk overlap in characters. */
    chunkOverlap: number
  }

  /** Default RAG configuration. */
  const DEFAULTS: Config = {
    sources: [],
    exclude: Crawler.DEFAULT_EXCLUDES,
    extensions: Crawler.DEFAULT_EXTENSIONS,
    chunkSize: 1000,
    chunkOverlap: 100,
  }

  /** Result of an indexing run. */
  export interface IndexResult {
    /** Total files discovered by crawler. */
    totalFiles: number
    /** Files that changed since last index. */
    changedFiles: number
    /** Files that were skipped (unchanged). */
    skippedFiles: number
    /** Total chunks generated from changed files. */
    chunksGenerated: number
    /** Chunks successfully embedded and stored. */
    chunksEmbedded: number
    /** Chunks that failed to embed. */
    errors: number
    /** Stale chunks removed (from deleted/changed files). */
    pruned: number
    /** Total time in milliseconds. */
    durationMs: number
  }

  /** Manifest entry tracking indexed file state. */
  interface ManifestEntry {
    /** File mtime when last indexed. */
    mtimeMs: number
    /** Content hash when last indexed. */
    contentHash: string
    /** Number of chunks generated from this file. */
    chunkCount: number
    /** Chunk IDs stored for this file. */
    chunkIDs: string[]
  }

  /** The full manifest mapping file paths to their indexed state. */
  type Manifest = Record<string, ManifestEntry>

  /**
   * Get the effective RAG config from user settings.
   *
   * @returns Merged RAG configuration
   */
  export async function getConfig(): Promise<Config> {
    let userConfig: Partial<Config> = {}
    try {
      const { Config: AppConfig } = await import("@/config/config")
      const config = await AppConfig.get()
      const embeddingConfig = (config as any).embedding
      log.info("RAG config lookup", {
        hasEmbedding: !!embeddingConfig,
        sources: embeddingConfig?.sources,
        configKeys: Object.keys(config),
      })
      if (embeddingConfig) {
        userConfig = {
          sources: embeddingConfig.sources,
          exclude: embeddingConfig.exclude,
          extensions: embeddingConfig.extensions,
          chunkSize: embeddingConfig.chunkSize,
          chunkOverlap: embeddingConfig.chunkOverlap,
        }
      }
    } catch (err: any) {
      log.warn("RAG config lookup failed", { error: err.message })
    }

    // Remove undefined values before merge
    const cleaned = Object.fromEntries(
      Object.entries(userConfig).filter(([_, v]) => v !== undefined),
    )
    return { ...DEFAULTS, ...cleaned }
  }

  /**
   * Check if RAG indexing is configured (has source directories).
   *
   * @returns true if sources are configured
   */
  export async function isConfigured(): Promise<boolean> {
    const config = await getConfig()
    return config.sources.length > 0
  }

  /**
   * Run the full RAG indexing pipeline.
   *
   * Crawls, chunks, embeds, and stores. Uses a manifest to track
   * what's been indexed for incremental updates.
   *
   * @param config - Optional config override
   * @param providerConfig - Optional embedding provider config
   * @returns Indexing result statistics
   */
  export async function index(
    config?: Partial<Config>,
    providerConfig?: Partial<EmbeddingProvider.ProviderConfig>,
  ): Promise<IndexResult> {
    const start = Date.now()
    const cfg = config ? { ...DEFAULTS, ...config } : await getConfig()

    if (cfg.sources.length === 0) {
      log.info("no RAG sources configured, skipping")
      return emptyResult(start)
    }

    // Check embedding provider
    const pCfg = providerConfig ?? (await EmbeddingProvider.getConfig())
    const available = await EmbeddingProvider.isAvailable(pCfg)
    if (!available) {
      log.warn("embedding provider not available for RAG indexing")
      return emptyResult(start)
    }

    // Load manifest
    const manifest = loadManifest()

    // Crawl all sources
    const files = Crawler.crawl({
      sources: cfg.sources,
      exclude: cfg.exclude,
      extensions: cfg.extensions,
    })

    const totalFiles = files.length
    log.info("RAG crawl complete", { totalFiles, sources: cfg.sources.length })

    // Determine changed files
    const changed: Crawler.FileEntry[] = []
    const unchanged: string[] = []
    const currentPaths = new Set<string>()

    for (const file of files) {
      currentPaths.add(file.absolutePath)
      const entry = manifest[file.absolutePath]

      if (entry && entry.mtimeMs >= file.mtimeMs) {
        // File hasn't changed
        unchanged.push(file.absolutePath)
      } else {
        changed.push(file)
      }
    }

    // Prune deleted files from manifest and store
    let pruned = 0
    for (const filePath of Object.keys(manifest)) {
      if (!currentPaths.has(filePath)) {
        const entry = manifest[filePath]
        for (const chunkID of entry.chunkIDs) {
          removeChunkEmbedding(chunkID)
        }
        delete manifest[filePath]
        pruned += entry.chunkIDs.length
      }
    }

    if (changed.length === 0) {
      saveManifest(manifest)
      log.info("RAG index is up to date", { totalFiles, unchanged: unchanged.length })
      return {
        totalFiles,
        changedFiles: 0,
        skippedFiles: unchanged.length,
        chunksGenerated: 0,
        chunksEmbedded: 0,
        errors: 0,
        pruned,
        durationMs: Date.now() - start,
      }
    }

    log.info("RAG indexing changed files", {
      changed: changed.length,
      unchanged: unchanged.length,
    })

    // Remove old embeddings for changed files
    for (const file of changed) {
      const entry = manifest[file.absolutePath]
      if (entry) {
        for (const chunkID of entry.chunkIDs) {
          removeChunkEmbedding(chunkID)
        }
        pruned += entry.chunkIDs.length
      }
    }

    // Chunk changed files
    const chunks = await Chunker.chunkFiles(changed, {
      chunkSize: cfg.chunkSize,
      chunkOverlap: cfg.chunkOverlap,
    })

    log.info("RAG chunking complete", {
      files: changed.length,
      chunks: chunks.length,
    })

    // Build file→chunks mapping for manifest updates
    const chunksByFile = new Map<string, Chunker.Chunk[]>()
    for (const chunk of chunks) {
      const existing = chunksByFile.get(chunk.filePath) ?? []
      existing.push(chunk)
      chunksByFile.set(chunk.filePath, existing)
    }

    // Embed and store in batches, saving manifest incrementally so
    // partial progress survives restarts.
    let embedded = 0
    let errors = 0
    const batchSize = pCfg.batchSize ?? 32
    const filesUpdatedInManifest = new Set<string>()

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const texts = batch.map((c) => Chunker.formatForEmbedding(c))

      try {
        const vectors = await EmbeddingProvider.embed(texts, pCfg)

        const entries = batch.map((chunk, idx) => ({
          nodeID: chunkIDToNodeID(chunk.chunkID),
          projectID: getProjectID(),
          vector: vectors[idx],
          contentHash: hashContent(chunk.content),
          model: pCfg.model ?? "nomic-embed-text",
        }))

        EmbeddingStore.batchUpsert(entries)

        // Populate FTS index alongside embeddings
        try {
          const ftsEntries = batch.map((chunk, idx) => {
            const meta = MetadataExtract.extract(chunk)
            return {
              nodeID: entries[idx].nodeID,
              projectID: getProjectID(),
              filePath: chunk.filePath,
              fileType: chunk.type,
              content: chunk.content,
              metadata: MetadataExtract.formatForFTS(meta),
            }
          })
          FTS.batchUpsert(ftsEntries)
        } catch (ftsErr: any) {
          log.warn("FTS indexing failed for batch, continuing", { error: ftsErr.message })
        }

        embedded += batch.length

        // Update manifest for files in this batch
        for (const chunk of batch) {
          if (!filesUpdatedInManifest.has(chunk.filePath)) {
            const file = changed.find((f) => f.absolutePath === chunk.filePath)
            if (file) {
              const fileChunks = chunksByFile.get(file.absolutePath) ?? []
              manifest[file.absolutePath] = {
                mtimeMs: file.mtimeMs,
                contentHash: hashFile(file.absolutePath),
                chunkCount: fileChunks.length,
                chunkIDs: fileChunks.map((c) => c.chunkID),
              }
              filesUpdatedInManifest.add(chunk.filePath)
            }
          }
        }

        // Save manifest every 10 batches to preserve progress
        if ((Math.floor(i / batchSize) + 1) % 10 === 0) {
          saveManifest(manifest)
        }

        log.info("RAG embedding batch", {
          batch: Math.floor(i / batchSize) + 1,
          total: Math.ceil(chunks.length / batchSize),
          count: batch.length,
        })
      } catch (err: any) {
        errors += batch.length
        log.error("RAG embedding batch failed", { error: err.message })
      }
    }

    // Final manifest save
    saveManifest(manifest)

    const result: IndexResult = {
      totalFiles,
      changedFiles: changed.length,
      skippedFiles: unchanged.length,
      chunksGenerated: chunks.length,
      chunksEmbedded: embedded,
      errors,
      pruned,
      durationMs: Date.now() - start,
    }

    log.info("RAG indexing complete", result)
    return result
  }

  /**
   * Search the RAG index with hybrid retrieval (vector + keyword + query expansion).
   *
   * Combines three search strategies:
   * 1. Vector similarity (semantic) — finds conceptually related chunks
   * 2. FTS5 keyword matching (exact) — catches exact CVE IDs, tool names, etc.
   * 3. Query expansion — extracts entities and runs targeted sub-queries
   *
   * Scores are blended: final = 0.6 * vector + 0.3 * keyword + 0.1 * expansion_bonus
   *
   * @param query - Natural language query
   * @param topK - Number of results (default: 20)
   * @param minSimilarity - Minimum similarity threshold (default: 0.3)
   * @returns Array of search results sorted by blended score
   */
  export async function search(
    query: string,
    topK: number = 20,
    minSimilarity: number = 0.3,
  ): Promise<SearchResult[]> {
    const config = await EmbeddingProvider.getConfig()
    const projectID = getProjectID()

    // Score accumulator: nodeID → { bestVectorScore, bestKeywordScore, chunkID }
    const scores = new Map<string, { vectorScore: number; keywordScore: number; chunkID: string }>()

    // ── 1. Primary vector search ──
    try {
      const queryHash = hashContent(query.trim().toLowerCase())
      let queryVec = EmbeddingStore.getCachedQuery(queryHash, config.model)
      if (!queryVec) {
        queryVec = await EmbeddingProvider.embedOne(query, config)
        EmbeddingStore.cacheQuery(queryHash, query, queryVec, config.model)
      }

      const vectorMatches = EmbeddingStore.search(queryVec, projectID, topK * 2, minSimilarity * 0.8)
      for (const match of vectorMatches) {
        const chunkID = nodeIDToChunkID(match.nodeID)
        const existing = scores.get(match.nodeID) ?? { vectorScore: 0, keywordScore: 0, chunkID }
        existing.vectorScore = Math.max(existing.vectorScore, match.similarity)
        existing.chunkID = chunkID
        scores.set(match.nodeID, existing)
      }
    } catch (err: any) {
      log.error("RAG vector search failed", { error: err.message })
    }

    // ── 2. FTS keyword search ──
    try {
      const ftsResults = FTS.search(query, projectID, topK * 2)
      for (const fts of ftsResults) {
        const chunkID = nodeIDToChunkID(fts.nodeID)
        const existing = scores.get(fts.nodeID) ?? { vectorScore: 0, keywordScore: 0, chunkID }
        existing.keywordScore = Math.max(existing.keywordScore, fts.score)
        existing.chunkID = chunkID
        scores.set(fts.nodeID, existing)
      }
    } catch (err: any) {
      log.warn("FTS search failed, continuing with vector-only", { error: err.message })
    }

    // ── 3. Query expansion (entity-specific sub-queries) ──
    const entities = QueryExpand.extractEntities(query)
    const hasExpansions = entities.cves.length > 0 || entities.attackIDs.length > 0

    if (hasExpansions) {
      try {
        // Search for each CVE ID individually via FTS (exact match)
        for (const cve of entities.cves) {
          const cveResults = FTS.search(cve, projectID, topK)
          for (const fts of cveResults) {
            const chunkID = nodeIDToChunkID(fts.nodeID)
            const existing = scores.get(fts.nodeID) ?? { vectorScore: 0, keywordScore: 0, chunkID }
            // CVE exact matches get a very strong keyword boost — the user asked
            // for this specific CVE, so it must outrank vector-similar but wrong CVEs
            existing.keywordScore = Math.max(existing.keywordScore, fts.score * 2.0)
            existing.chunkID = chunkID
            scores.set(fts.nodeID, existing)
          }
        }

        // Search for ATT&CK IDs
        for (const tid of entities.attackIDs) {
          const tidResults = FTS.search(tid, projectID, 5)
          for (const fts of tidResults) {
            const chunkID = nodeIDToChunkID(fts.nodeID)
            const existing = scores.get(fts.nodeID) ?? { vectorScore: 0, keywordScore: 0, chunkID }
            existing.keywordScore = Math.max(existing.keywordScore, fts.score)
            existing.chunkID = chunkID
            scores.set(fts.nodeID, existing)
          }
        }

        // Also run expanded vector searches for CVE-related queries
        for (const cve of entities.cves.slice(0, 2)) {
          try {
            const expandedQuery = `${cve} vulnerability exploit detection`
            const expandedHash = hashContent(expandedQuery.trim().toLowerCase())
            let expandedVec = EmbeddingStore.getCachedQuery(expandedHash, config.model)
            if (!expandedVec) {
              expandedVec = await EmbeddingProvider.embedOne(expandedQuery, config)
              EmbeddingStore.cacheQuery(expandedHash, expandedQuery, expandedVec, config.model)
            }
            const expandedMatches = EmbeddingStore.search(expandedVec, projectID, 10, minSimilarity)
            for (const match of expandedMatches) {
              const chunkID = nodeIDToChunkID(match.nodeID)
              const existing = scores.get(match.nodeID) ?? { vectorScore: 0, keywordScore: 0, chunkID }
              existing.vectorScore = Math.max(existing.vectorScore, match.similarity * 0.9)
              existing.chunkID = chunkID
              scores.set(match.nodeID, existing)
            }
          } catch {
            // Non-critical — continue without expanded vector search
          }
        }
      } catch (err: any) {
        log.warn("query expansion search failed", { error: err.message })
      }
    }

    // ── Blend scores and build results ──
    // When the query contains specific identifiers (CVE numbers, ATT&CK IDs),
    // keyword matches are more important than vector similarity. A query for
    // "CVE-2025-34037" must rank that CVE's files above vector-similar but
    // wrong CVEs like "CVE-2021-21315".
    const VECTOR_WEIGHT = hasExpansions ? 0.3 : 0.6
    const KEYWORD_WEIGHT = hasExpansions ? 0.7 : 0.4

    const blended: Array<{ nodeID: string; chunkID: string; score: number }> = []
    for (const [nodeID, s] of scores) {
      const score = VECTOR_WEIGHT * s.vectorScore + KEYWORD_WEIGHT * s.keywordScore
      if (score >= minSimilarity * 0.5) {
        blended.push({ nodeID, chunkID: s.chunkID, score: Math.min(score, 1.0) })
      }
    }

    blended.sort((a, b) => b.score - a.score)
    const topResults = blended.slice(0, topK)

    // Build final results
    const results: SearchResult[] = []
    for (const item of topResults) {
      const parts = parseChunkID(item.chunkID)
      if (!parts) continue

      results.push({
        chunkID: item.chunkID,
        filePath: parts.filePath,
        startLine: parts.startLine,
        endLine: parts.endLine,
        similarity: item.score,
      })
    }

    log.info("RAG hybrid search complete", {
      query: query.slice(0, 80),
      vectorHits: [...scores.values()].filter((s) => s.vectorScore > 0).length,
      keywordHits: [...scores.values()].filter((s) => s.keywordScore > 0).length,
      expanded: hasExpansions,
      results: results.length,
    })

    return results
  }

  /** Search result from the RAG index. */
  export interface SearchResult {
    /** Chunk identifier. */
    chunkID: string
    /** Absolute file path. */
    filePath: string
    /** Start line in the file. */
    startLine: number
    /** End line in the file. */
    endLine: number
    /** Blended similarity score (0-1). */
    similarity: number
  }

  /**
   * Get RAG index statistics.
   *
   * @returns Stats about the RAG index
   */
  export function stats(): {
    configured: boolean
    totalFiles: number
    totalChunks: number
    embeddingStats: { count: number; dimension: number | null; model: string | null }
  } {
    const manifest = loadManifest()
    const totalFiles = Object.keys(manifest).length
    let totalChunks = 0
    for (const entry of Object.values(manifest)) {
      totalChunks += entry.chunkCount
    }

    const embeddingStats = EmbeddingStore.stats(getProjectID())

    return { configured: totalFiles > 0, totalFiles, totalChunks, embeddingStats }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Get the project ID for RAG embeddings.
   *
   * Uses the current project's ID so embeddings satisfy the FK constraint.
   * RAG embeddings are distinguished from graph embeddings by the `rag:` prefix
   * on their node_id values.
   *
   * @returns Current project ID
   */
  function getProjectID(): string {
    try {
      return Instance.project.id
    } catch {
      // Fallback for testing contexts where Instance isn't available
      return "__rag__"
    }
  }

  /** Path to the RAG manifest file. */
  function manifestPath(): string {
    return path.join(Global.Path.data, "rag-manifest.json")
  }

  /** Load the manifest from disk. */
  function loadManifest(): Manifest {
    const p = manifestPath()
    if (!existsSync(p)) return {}
    try {
      return JSON.parse(readFileSync(p, "utf-8"))
    } catch {
      return {}
    }
  }

  /** Save the manifest to disk. */
  function saveManifest(manifest: Manifest): void {
    const p = manifestPath()
    const dir = path.dirname(p)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(p, JSON.stringify(manifest, null, 2))
  }

  /** Hash file content for change detection. */
  function hashFile(filePath: string): string {
    try {
      const content = readFileSync(filePath, "utf-8")
      return hashContent(content)
    } catch {
      return ""
    }
  }

  /** Hash a string. */
  function hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16)
  }

  /** Convert a chunk ID to a node ID for the embedding store. */
  function chunkIDToNodeID(chunkID: string): string {
    return `rag:${hashContent(chunkID)}`
  }

  /** Convert a node ID back to a chunk ID (lossy — we store the mapping in manifest). */
  function nodeIDToChunkID(nodeID: string): string {
    // We can't reverse the hash, so search the manifest
    const manifest = loadManifest()
    for (const entry of Object.values(manifest)) {
      for (const cid of entry.chunkIDs) {
        if (chunkIDToNodeID(cid) === nodeID) return cid
      }
    }
    return nodeID
  }

  /** Parse a chunk ID into file path and line range. */
  function parseChunkID(chunkID: string): { filePath: string; startLine: number; endLine: number } | undefined {
    const match = chunkID.match(/^(.+):(\d+)-(\d+)$/)
    if (!match) return undefined
    return {
      filePath: match[1],
      startLine: parseInt(match[2], 10),
      endLine: parseInt(match[3], 10),
    }
  }

  /** Remove a chunk's embedding and FTS entry from the store. */
  function removeChunkEmbedding(chunkID: string): void {
    const nodeID = chunkIDToNodeID(chunkID)
    try {
      EmbeddingStore.remove(getProjectID(), nodeID)
      FTS.remove(nodeID)
    } catch {
      // May not exist — that's fine
    }
  }

  /** Empty result for early returns. */
  function emptyResult(start: number): IndexResult {
    return {
      totalFiles: 0,
      changedFiles: 0,
      skippedFiles: 0,
      chunksGenerated: 0,
      chunksEmbedded: 0,
      errors: 0,
      pruned: 0,
      durationMs: Date.now() - start,
    }
  }
}
