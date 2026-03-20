import { sqliteTable, text, integer, blob, index, primaryKey } from "drizzle-orm/sqlite-core"
import { GraphNodeTable } from "../graph/schema.sql"
import { ProjectTable } from "../project/project.sql"

/**
 * Embedding storage tables for semantic code search.
 *
 * Stores vector embeddings as BLOBs (Float32Array serialized).
 * Keyed by graph node ID with content hash for cache invalidation.
 */

/** Per-node embedding vectors. */
export const EmbeddingTable = sqliteTable(
  "embedding",
  {
    /** Graph node ID this embedding represents. */
    node_id: text().notNull(),
    /** Project ID for scoped queries. */
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    /** Serialized Float32Array embedding vector. */
    vector: blob({ mode: "buffer" }).notNull(),
    /** Embedding dimension for validation. */
    dimension: integer().notNull(),
    /** Content hash of the source code — used for cache invalidation. */
    content_hash: text().notNull(),
    /** Embedding model identifier (e.g. "nomic-embed-text"). */
    model: text().notNull(),
    /** Unix timestamp when this embedding was created/updated. */
    created_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.node_id, table.project_id] }),
    index("embedding_project_idx").on(table.project_id),
    index("embedding_hash_idx").on(table.project_id, table.content_hash),
  ],
)

/** Cached query embeddings to avoid re-embedding repeated queries. */
export const QueryEmbeddingCacheTable = sqliteTable(
  "query_embedding_cache",
  {
    /** SHA-256 hash of the query text. */
    query_hash: text().primaryKey(),
    /** Original query text. */
    query_text: text().notNull(),
    /** Serialized Float32Array embedding vector. */
    vector: blob({ mode: "buffer" }).notNull(),
    /** Embedding dimension. */
    dimension: integer().notNull(),
    /** Embedding model identifier. */
    model: text().notNull(),
    /** Unix timestamp when cached. */
    created_at: integer().notNull(),
  },
  (table) => [index("query_cache_model_idx").on(table.model)],
)
