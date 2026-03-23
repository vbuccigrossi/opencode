import { Database, sql } from "@/storage/db"
import { Log } from "@/util/log"

/**
 * Full-text search for RAG chunks using SQLite FTS5.
 *
 * Provides keyword-based search alongside vector similarity for hybrid
 * retrieval. FTS5 catches exact string matches (CVE IDs, function names,
 * tool names) that embedding similarity alone might miss.
 */
export namespace FTS {
  const log = Log.create({ service: "embedding.fts" })

  /** Whether the FTS table has been initialized. */
  let _initialized = false

  /**
   * Ensure the FTS5 virtual table exists.
   *
   * Creates the table if it doesn't exist. Safe to call multiple times.
   */
  export function ensureTable(): void {
    if (_initialized) return
    try {
      Database.use((db) => {
        db.run(sql`
          CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
            node_id,
            project_id UNINDEXED,
            file_path UNINDEXED,
            file_type UNINDEXED,
            content,
            metadata,
            tokenize='porter unicode61'
          )
        `)
      })
      _initialized = true
      log.info("FTS table ready")
    } catch (err: any) {
      log.error("FTS table creation failed", { error: err.message })
    }
  }

  /**
   * Insert or replace a chunk in the FTS index.
   *
   * @param nodeID - Unique node identifier (matches embedding table)
   * @param projectID - Project scope
   * @param filePath - Absolute file path
   * @param fileType - File type classification
   * @param content - Chunk text content
   * @param metadata - Extracted metadata string (CVEs, ATT&CK IDs, etc.)
   */
  export function upsert(
    nodeID: string,
    projectID: string,
    filePath: string,
    fileType: string,
    content: string,
    metadata: string,
  ): void {
    ensureTable()
    try {
      Database.use((db) => {
        db.run(sql`DELETE FROM rag_fts WHERE node_id = ${nodeID}`)
        db.run(sql`
          INSERT INTO rag_fts(node_id, project_id, file_path, file_type, content, metadata)
          VALUES (${nodeID}, ${projectID}, ${filePath}, ${fileType}, ${content}, ${metadata})
        `)
      })
    } catch (err: any) {
      log.warn("FTS upsert failed", { nodeID, error: err.message })
    }
  }

  /**
   * Batch insert chunks into the FTS index.
   *
   * @param entries - Array of chunk data to index
   */
  export function batchUpsert(
    entries: Array<{
      nodeID: string
      projectID: string
      filePath: string
      fileType: string
      content: string
      metadata: string
    }>,
  ): void {
    ensureTable()
    if (entries.length === 0) return

    try {
      Database.use((db) => {
        for (const entry of entries) {
          db.run(sql`DELETE FROM rag_fts WHERE node_id = ${entry.nodeID}`)
          db.run(sql`
            INSERT INTO rag_fts(node_id, project_id, file_path, file_type, content, metadata)
            VALUES (
              ${entry.nodeID}, ${entry.projectID}, ${entry.filePath},
              ${entry.fileType}, ${entry.content}, ${entry.metadata}
            )
          `)
        }
      })
    } catch (err: any) {
      log.error("FTS batch upsert failed", { count: entries.length, error: err.message })
    }
  }

  /**
   * Remove a chunk from the FTS index.
   *
   * @param nodeID - Node identifier to remove
   */
  export function remove(nodeID: string): void {
    ensureTable()
    try {
      Database.use((db) => {
        db.run(sql`DELETE FROM rag_fts WHERE node_id = ${nodeID}`)
      })
    } catch (err: any) {
      log.warn("FTS remove failed", { nodeID, error: err.message })
    }
  }

  /**
   * Remove all FTS entries for a project.
   *
   * @param projectID - Project to clear
   */
  export function removeProject(projectID: string): void {
    ensureTable()
    try {
      Database.use((db) => {
        db.run(sql`DELETE FROM rag_fts WHERE project_id = ${projectID}`)
      })
    } catch (err: any) {
      log.warn("FTS removeProject failed", { projectID, error: err.message })
    }
  }

  /**
   * Search the FTS index using keyword matching.
   *
   * Uses FTS5 MATCH with BM25 ranking for relevance scoring.
   * Results are normalized to a 0-1 similarity scale for blending
   * with vector search scores.
   *
   * @param query - Search query (supports FTS5 syntax: quotes for phrase, OR, NOT)
   * @param projectID - Project scope
   * @param topK - Maximum results (default: 20)
   * @returns Array of results with normalized scores
   */
  export function search(
    query: string,
    projectID: string,
    topK: number = 20,
  ): Array<{ nodeID: string; score: number; filePath: string }> {
    ensureTable()

    const ftsQuery = sanitizeQuery(query)
    if (!ftsQuery) return []

    try {
      // Use raw bun:sqlite via drizzle's $client for FTS5 queries
      // since drizzle's ORM doesn't support virtual tables natively
      const rows = Database.use((db) => {
        const client = (db as any).$client
        if (!client) return []
        const stmt = client.prepare(
          `SELECT node_id, file_path, rank
           FROM rag_fts
           WHERE rag_fts MATCH ?
             AND project_id = ?
           ORDER BY rank
           LIMIT ?`,
        )
        return stmt.all(ftsQuery, projectID, topK) as Array<{
          node_id: string
          file_path: string
          rank: number
        }>
      })

      if (!rows || rows.length === 0) return []

      // BM25 rank is negative (lower = better match). Normalize to 0-1 scale.
      const minRank = Math.min(...rows.map((r) => r.rank))
      const maxRank = Math.max(...rows.map((r) => r.rank))
      const range = maxRank - minRank || 1

      return rows.map((row) => ({
        nodeID: row.node_id,
        filePath: row.file_path,
        score: range === 0 ? 1.0 : 1 - (row.rank - minRank) / range,
      }))
    } catch (err: any) {
      log.warn("FTS search failed", { query: ftsQuery, error: err.message })
      return []
    }
  }

  /**
   * Sanitize a query string for FTS5 MATCH syntax.
   *
   * @param query - Raw user query
   * @returns FTS5-safe query string, or empty string if invalid
   */
  function sanitizeQuery(query: string): string {
    if (!query || query.trim().length === 0) return ""

    // Strip punctuation that's not part of identifiers before tokenizing
    const cleaned = query
      .replace(/[*(){}[\]^~?!.,;:'"]/g, " ")
      .replace(/\s+/g, " ")
      .trim()

    const tokens = cleaned
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => {
        // CVE IDs — must be quoted so hyphens aren't treated as FTS operators
        if (/^CVE-\d{4}-\d{4,}$/i.test(t)) return `"${t}"`
        // MITRE ATT&CK IDs
        if (/^T\d{4}(\.\d{3})?$/.test(t)) return `"${t}"`
        // Any token with hyphens (could be a compound identifier) — quote it
        if (t.includes("-") && t.length > 3) return `"${t}"`
        // Strip remaining quotes
        return t.replace(/"/g, "")
      })
      .filter((t) => t.length > 0)

    if (tokens.length === 0) return ""
    return tokens.join(" ")
  }

  /**
   * Get FTS index statistics.
   *
   * @param projectID - Project to check
   * @returns Number of indexed chunks
   */
  export function count(projectID: string): number {
    ensureTable()
    try {
      const result = Database.use((db) => {
        const client = (db as any).$client
        if (!client) return 0
        const stmt = client.prepare(
          `SELECT COUNT(*) as cnt FROM rag_fts WHERE project_id = ?`,
        )
        const row = stmt.get(projectID) as { cnt: number } | null
        return row?.cnt ?? 0
      })
      return result
    } catch {
      return 0
    }
  }
}
