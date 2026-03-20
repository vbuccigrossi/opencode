import { Database, eq } from "@/storage/db"
import { GraphNodeTable } from "@/graph/schema.sql"
import { EmbeddingProvider } from "./provider"
import { EmbeddingStore } from "./store"
import { Log } from "@/util/log"
import { readFileSync } from "fs"
import path from "path"

/**
 * Code embedding indexer — walks graph nodes and generates embeddings.
 *
 * Incrementally indexes code entities from the graph database. Uses content
 * hash comparison to skip unchanged nodes. Embeds a combination of the
 * entity's signature, context (file path, kind), and body for rich semantic
 * representation.
 */
export namespace EmbeddingIndexer {
  const log = Log.create({ service: "embedding.indexer" })

  /** Indexing result statistics. */
  export interface IndexResult {
    /** Total graph nodes in the project. */
    totalNodes: number
    /** Nodes that already had up-to-date embeddings (skipped). */
    skipped: number
    /** Nodes newly embedded in this run. */
    indexed: number
    /** Nodes whose embeddings were updated (content hash changed). */
    updated: number
    /** Stale embeddings pruned (node no longer in graph). */
    pruned: number
    /** Nodes that failed to embed. */
    errors: number
    /** Total time in milliseconds. */
    durationMs: number
  }

  /**
   * Build the text representation of a graph node for embedding.
   *
   * Combines file path, kind, name, signature, and a snippet of the body
   * to create a semantically rich text for the embedding model.
   *
   * @param node - Graph node data
   * @param directory - Project root directory for reading source files
   * @returns Text string suitable for embedding
   */
  export function buildEmbeddingText(
    node: {
      name: string
      kind: string
      file_path: string
      signature: string | null
      start_line: number
      end_line: number
    },
    directory: string,
  ): string {
    const parts: string[] = []

    // File context
    const relPath = path.relative(directory, node.file_path)
    parts.push(`File: ${relPath}`)
    parts.push(`Kind: ${node.kind}`)
    parts.push(`Name: ${node.name}`)

    // Signature if available
    if (node.signature) {
      parts.push(`Signature: ${node.signature}`)
    }

    // Try to read the actual source body (truncated to ~500 chars)
    try {
      const content = readFileSync(node.file_path, "utf-8")
      const lines = content.split("\n")
      const start = Math.max(0, node.start_line - 1)
      const end = Math.min(lines.length, node.end_line)
      const body = lines.slice(start, end).join("\n")

      // Truncate long bodies
      if (body.length > 500) {
        parts.push(`Body: ${body.slice(0, 500)}...`)
      } else {
        parts.push(`Body: ${body}`)
      }
    } catch {
      // File may have been deleted since indexing — use signature only
    }

    return parts.join("\n")
  }

  /**
   * Run incremental embedding indexing for a project.
   *
   * Compares content hashes between graph nodes and stored embeddings.
   * Only re-embeds nodes that are new or have changed. Prunes embeddings
   * for nodes that no longer exist in the graph.
   *
   * @param projectID - Project identifier
   * @param directory - Project root directory
   * @param config - Optional embedding provider config override
   * @returns Indexing statistics
   */
  export async function index(
    projectID: string,
    directory: string,
    config?: Partial<EmbeddingProvider.ProviderConfig>,
  ): Promise<IndexResult> {
    const start = Date.now()
    const providerConfig = config ?? (await EmbeddingProvider.getConfig())

    // Check if embedding provider is available
    const available = await EmbeddingProvider.isAvailable(providerConfig)
    if (!available) {
      log.warn("embedding provider not available, skipping indexing", {
        baseURL: providerConfig.baseURL,
        model: providerConfig.model,
      })
      return {
        totalNodes: 0,
        skipped: 0,
        indexed: 0,
        updated: 0,
        pruned: 0,
        errors: 0,
        durationMs: Date.now() - start,
      }
    }

    // Get all graph nodes for this project
    const nodes = Database.use((db) =>
      db
        .select({
          id: GraphNodeTable.id,
          name: GraphNodeTable.name,
          kind: GraphNodeTable.kind,
          file_path: GraphNodeTable.file_path,
          signature: GraphNodeTable.signature,
          start_line: GraphNodeTable.start_line,
          end_line: GraphNodeTable.end_line,
          content_hash: GraphNodeTable.content_hash,
        })
        .from(GraphNodeTable)
        .where(eq(GraphNodeTable.project_id, projectID))
        .all(),
    )

    const totalNodes = nodes.length
    if (totalNodes === 0) {
      return { totalNodes: 0, skipped: 0, indexed: 0, updated: 0, pruned: 0, errors: 0, durationMs: Date.now() - start }
    }

    // Get existing embedding content hashes
    const existingHashes = EmbeddingStore.contentHashes(projectID)

    // Classify nodes: skip (unchanged), embed (new/changed)
    const toEmbed: typeof nodes = []
    let skipped = 0
    let updated = 0

    for (const node of nodes) {
      const existingHash = existingHashes.get(node.id)
      if (existingHash === node.content_hash) {
        skipped++
      } else {
        if (existingHash) updated++
        toEmbed.push(node)
      }
    }

    // Prune stale embeddings (nodes removed from graph)
    const validNodeIDs = new Set(nodes.map((n) => n.id))
    const pruned = EmbeddingStore.pruneStale(projectID, validNodeIDs)

    // Embed in batches
    let indexed = 0
    let errors = 0
    const batchSize = providerConfig.batchSize ?? 32

    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize)
      const texts = batch.map((node) => buildEmbeddingText(node, directory))

      try {
        const vectors = await EmbeddingProvider.embed(texts, providerConfig)

        const entries = batch.map((node, idx) => ({
          nodeID: node.id,
          projectID,
          vector: vectors[idx],
          contentHash: node.content_hash,
          model: providerConfig.model ?? "nomic-embed-text",
        }))

        EmbeddingStore.batchUpsert(entries)
        indexed += batch.length

        log.info("embedding batch indexed", {
          batch: Math.floor(i / batchSize) + 1,
          total: Math.ceil(toEmbed.length / batchSize),
          count: batch.length,
        })
      } catch (err: any) {
        errors += batch.length
        log.error("embedding batch failed", {
          batch: Math.floor(i / batchSize) + 1,
          error: err.message,
        })
      }
    }

    const result: IndexResult = {
      totalNodes,
      skipped,
      indexed,
      updated,
      pruned,
      errors,
      durationMs: Date.now() - start,
    }

    log.info("embedding indexing complete", result)
    return result
  }
}
