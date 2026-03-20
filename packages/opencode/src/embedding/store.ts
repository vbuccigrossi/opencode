import { Database, eq, and, sql } from "@/storage/db"
import { EmbeddingTable, QueryEmbeddingCacheTable } from "./schema.sql"
import { Log } from "@/util/log"

/**
 * Vector storage and retrieval backed by SQLite.
 *
 * Stores embeddings as serialized Float32Arrays in BLOB columns.
 * Cosine similarity is computed in TypeScript for portability.
 * This approach is efficient for codebase-scale datasets (100s to low 1000s of vectors).
 */
export namespace EmbeddingStore {
  const log = Log.create({ service: "embedding.store" })

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  /**
   * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
   *
   * @param vec - Float32Array embedding vector
   * @returns Buffer containing the raw bytes
   */
  export function serialize(vec: Float32Array): Buffer {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
  }

  /**
   * Deserialize a Buffer from SQLite back to a Float32Array.
   *
   * @param buf - Buffer from SQLite BLOB column
   * @returns Float32Array embedding vector
   */
  export function deserialize(buf: Buffer): Float32Array {
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return new Float32Array(arrayBuf)
  }

  // -------------------------------------------------------------------------
  // Vector Operations
  // -------------------------------------------------------------------------

  /**
   * Compute cosine similarity between two vectors.
   *
   * Returns a value between -1 and 1 where:
   *   1 = identical direction
   *   0 = orthogonal
   *  -1 = opposite direction
   *
   * @param a - First vector
   * @param b - Second vector
   * @returns Cosine similarity score
   */
  export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
    }

    let dot = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    if (denom === 0) return 0

    return dot / denom
  }

  /**
   * Find the top-K most similar vectors to a query vector.
   *
   * Performs brute-force cosine similarity against all stored vectors
   * for a project. Fast enough for typical codebase sizes (<10k nodes).
   *
   * @param queryVec - Query embedding vector
   * @param projectID - Project to search within
   * @param topK - Number of results to return (default: 20)
   * @param minSimilarity - Minimum similarity threshold (default: 0.3)
   * @returns Array of {nodeID, similarity} sorted by similarity descending
   */
  export function search(
    queryVec: Float32Array,
    projectID: string,
    topK: number = 20,
    minSimilarity: number = 0.3,
  ): Array<{ nodeID: string; similarity: number }> {
    const rows = Database.use((db) =>
      db
        .select({
          node_id: EmbeddingTable.node_id,
          vector: EmbeddingTable.vector,
        })
        .from(EmbeddingTable)
        .where(eq(EmbeddingTable.project_id, projectID))
        .all(),
    )

    const scored = rows
      .map((row) => {
        const vec = deserialize(row.vector as unknown as Buffer)
        const similarity = cosineSimilarity(queryVec, vec)
        return { nodeID: row.node_id, similarity }
      })
      .filter((r) => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK)

    return scored
  }

  // -------------------------------------------------------------------------
  // CRUD Operations
  // -------------------------------------------------------------------------

  /**
   * Upsert an embedding for a graph node.
   *
   * @param nodeID - Graph node ID
   * @param projectID - Project ID
   * @param vector - Float32Array embedding
   * @param contentHash - Content hash for cache invalidation
   * @param model - Embedding model name
   */
  export function upsert(
    nodeID: string,
    projectID: string,
    vector: Float32Array,
    contentHash: string,
    model: string,
  ): void {
    const now = Date.now()
    Database.use((db) =>
      db
        .insert(EmbeddingTable)
        .values({
          node_id: nodeID,
          project_id: projectID,
          vector: serialize(vector),
          dimension: vector.length,
          content_hash: contentHash,
          model,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: [EmbeddingTable.node_id, EmbeddingTable.project_id],
          set: {
            vector: serialize(vector),
            dimension: vector.length,
            content_hash: contentHash,
            model,
            created_at: now,
          },
        })
        .run(),
    )
  }

  /**
   * Batch upsert embeddings in a single transaction.
   *
   * @param entries - Array of embedding entries to upsert
   */
  export function batchUpsert(
    entries: Array<{
      nodeID: string
      projectID: string
      vector: Float32Array
      contentHash: string
      model: string
    }>,
  ): void {
    if (entries.length === 0) return
    const now = Date.now()

    Database.use((db) => {
      for (const entry of entries) {
        db.insert(EmbeddingTable)
          .values({
            node_id: entry.nodeID,
            project_id: entry.projectID,
            vector: serialize(entry.vector),
            dimension: entry.vector.length,
            content_hash: entry.contentHash,
            model: entry.model,
            created_at: now,
          })
          .onConflictDoUpdate({
            target: [EmbeddingTable.node_id, EmbeddingTable.project_id],
            set: {
              vector: serialize(entry.vector),
              dimension: entry.vector.length,
              content_hash: entry.contentHash,
              model: entry.model,
              created_at: now,
            },
          })
          .run()
      }
    })
  }

  /**
   * Get the embedding for a specific node.
   *
   * @param nodeID - Graph node ID
   * @param projectID - Project ID
   * @returns Embedding info or undefined
   */
  export function get(
    nodeID: string,
    projectID: string,
  ):
    | {
        vector: Float32Array
        contentHash: string
        model: string
        createdAt: number
      }
    | undefined {
    const row = Database.use((db) =>
      db
        .select()
        .from(EmbeddingTable)
        .where(and(eq(EmbeddingTable.node_id, nodeID), eq(EmbeddingTable.project_id, projectID)))
        .get(),
    )

    if (!row) return undefined

    return {
      vector: deserialize(row.vector as unknown as Buffer),
      contentHash: row.content_hash,
      model: row.model,
      createdAt: row.created_at,
    }
  }

  /**
   * Get a map of nodeID → contentHash for all embeddings in a project.
   *
   * Used by the indexer to detect stale embeddings.
   *
   * @param projectID - Project ID
   * @returns Map of nodeID to contentHash
   */
  export function contentHashes(projectID: string): Map<string, string> {
    const rows = Database.use((db) =>
      db
        .select({
          node_id: EmbeddingTable.node_id,
          content_hash: EmbeddingTable.content_hash,
        })
        .from(EmbeddingTable)
        .where(eq(EmbeddingTable.project_id, projectID))
        .all(),
    )

    const map = new Map<string, string>()
    for (const row of rows) {
      map.set(row.node_id, row.content_hash)
    }
    return map
  }

  /**
   * Delete embeddings for nodes that no longer exist in the graph.
   *
   * @param projectID - Project ID
   * @param validNodeIDs - Set of node IDs still in the graph
   * @returns Number of embeddings deleted
   */
  export function pruneStale(projectID: string, validNodeIDs: Set<string>): number {
    const existing = contentHashes(projectID)
    let deleted = 0

    Database.use((db) => {
      for (const nodeID of existing.keys()) {
        if (!validNodeIDs.has(nodeID)) {
          db.delete(EmbeddingTable)
            .where(and(eq(EmbeddingTable.node_id, nodeID), eq(EmbeddingTable.project_id, projectID)))
            .run()
          deleted++
        }
      }
    })

    if (deleted > 0) {
      log.info("pruned stale embeddings", { projectID, deleted })
    }
    return deleted
  }

  /**
   * Get statistics about stored embeddings for a project.
   *
   * @param projectID - Project ID
   * @returns Count, dimension, model info
   */
  export function stats(projectID: string): {
    count: number
    dimension: number | null
    model: string | null
  } {
    const result = Database.use((db) =>
      db
        .select({
          count: sql<number>`count(*)`,
          dimension: sql<number | null>`max(${EmbeddingTable.dimension})`,
          model: sql<string | null>`max(${EmbeddingTable.model})`,
        })
        .from(EmbeddingTable)
        .where(eq(EmbeddingTable.project_id, projectID))
        .get(),
    )

    return {
      count: result?.count ?? 0,
      dimension: result?.dimension ?? null,
      model: result?.model ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // Query Embedding Cache
  // -------------------------------------------------------------------------

  /**
   * Cache a query embedding for reuse.
   *
   * @param queryHash - SHA-256 hash of the query text
   * @param queryText - Original query text
   * @param vector - Embedding vector
   * @param model - Embedding model name
   */
  export function cacheQuery(queryHash: string, queryText: string, vector: Float32Array, model: string): void {
    Database.use((db) =>
      db
        .insert(QueryEmbeddingCacheTable)
        .values({
          query_hash: queryHash,
          query_text: queryText,
          vector: serialize(vector),
          dimension: vector.length,
          model,
          created_at: Date.now(),
        })
        .onConflictDoUpdate({
          target: QueryEmbeddingCacheTable.query_hash,
          set: {
            vector: serialize(vector),
            dimension: vector.length,
            model,
            created_at: Date.now(),
          },
        })
        .run(),
    )
  }

  /**
   * Get a cached query embedding.
   *
   * @param queryHash - SHA-256 hash of the query text
   * @param model - Required model match
   * @returns Cached vector or undefined
   */
  export function getCachedQuery(queryHash: string, model: string): Float32Array | undefined {
    const row = Database.use((db) =>
      db
        .select()
        .from(QueryEmbeddingCacheTable)
        .where(and(eq(QueryEmbeddingCacheTable.query_hash, queryHash), eq(QueryEmbeddingCacheTable.model, model)))
        .get(),
    )

    if (!row) return undefined
    return deserialize(row.vector as unknown as Buffer)
  }
}
