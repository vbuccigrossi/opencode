import { Database, eq, and, like, sql } from "@/storage/db"
import { GraphNodeTable, GraphEdgeTable, GraphFileStateTable } from "./schema.sql"
import { GraphBuilder } from "./builder"
import { GraphParser } from "./parser"
import { GraphCache } from "./cache"
import { Instance } from "@/project/instance"
import { Scheduler } from "@/scheduler"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { File } from "@/file"
import z from "zod"
import type { GraphNode, GraphEdge } from "./node"
import { BusEvent } from "@/bus/bus-event"

/**
 * Repository knowledge graph — the public API.
 *
 * Provides queries for navigating code structure: finding symbols,
 * tracing call graphs, analyzing imports, and computing change impact.
 * Manages graph lifecycle (building, incremental updates, cleanup).
 */
export namespace Graph {
  const log = Log.create({ service: "graph" })

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  export const IndexStarted = BusEvent.define(
    "graph.index.started",
    z.object({
      projectID: z.string(),
      directory: z.string(),
    }),
  )

  export const IndexComplete = BusEvent.define(
    "graph.index.complete",
    z.object({
      projectID: z.string(),
      indexed: z.number(),
      skipped: z.number(),
      total: z.number(),
      errors: z.number(),
      durationMs: z.number(),
    }),
  )

  export const FileIndexed = BusEvent.define(
    "graph.file.indexed",
    z.object({
      projectID: z.string(),
      filePath: z.string(),
      nodeCount: z.number(),
    }),
  )

  // -------------------------------------------------------------------------
  // Query Results
  // -------------------------------------------------------------------------

  export interface NodeResult {
    id: string
    filePath: string
    name: string
    kind: GraphNode.Kind
    startLine: number
    endLine: number
    signature?: string | null
  }

  export interface EdgeResult {
    sourceNode: NodeResult
    targetNode: NodeResult
    kind: GraphEdge.Kind
    line?: number | null
  }

  export interface ImpactResult {
    directDependents: NodeResult[]
    transitiveDependents: NodeResult[]
    affectedTests: NodeResult[]
    affectedFiles: string[]
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Finds nodes by name, optionally filtered by kind.
   *
   * @param projectID - Project scope
   * @param name - Symbol name to search for (supports SQL LIKE patterns)
   * @param kind - Optional filter by node kind
   * @returns Matching nodes
   */
  export function findSymbol(
    projectID: string,
    name: string,
    kind?: GraphNode.Kind,
  ): NodeResult[] {
    const conditions = [eq(GraphNodeTable.project_id, projectID)]

    // Support both exact match and LIKE patterns
    if (name.includes("%") || name.includes("_")) {
      conditions.push(like(GraphNodeTable.name, name))
    } else {
      conditions.push(eq(GraphNodeTable.name, name))
    }

    if (kind) {
      conditions.push(eq(GraphNodeTable.kind, kind))
    }

    return Database.use((db) =>
      db
        .select({
          id: GraphNodeTable.id,
          filePath: GraphNodeTable.file_path,
          name: GraphNodeTable.name,
          kind: GraphNodeTable.kind,
          startLine: GraphNodeTable.start_line,
          endLine: GraphNodeTable.end_line,
          signature: GraphNodeTable.signature,
        })
        .from(GraphNodeTable)
        .where(and(...conditions))
        .all() as NodeResult[],
    )
  }

  /**
   * Finds all callers of a given symbol. Results are cached.
   *
   * @param projectID - Project scope
   * @param symbolName - Name of the function/method being called
   * @returns Nodes that call the target symbol
   */
  export function callersOf(projectID: string, symbolName: string): NodeResult[] {
    const cacheKey = GraphCache.key(projectID, "callersOf", symbolName)
    const cached = GraphCache.get<NodeResult[]>(cacheKey)
    if (cached) return cached

    // Find the target node(s)
    const targets = findSymbol(projectID, symbolName)
    if (targets.length === 0) return []

    const targetIDs = targets.map((t) => t.id)

    const results = Database.use((db) => {
      const results: NodeResult[] = []
      for (const targetID of targetIDs) {
        const edges = db
          .select({
            sourceID: GraphEdgeTable.source_node_id,
          })
          .from(GraphEdgeTable)
          .where(
            and(
              eq(GraphEdgeTable.project_id, projectID),
              eq(GraphEdgeTable.target_node_id, targetID),
              eq(GraphEdgeTable.kind, "calls"),
            ),
          )
          .all()

        for (const edge of edges) {
          const node = db
            .select({
              id: GraphNodeTable.id,
              filePath: GraphNodeTable.file_path,
              name: GraphNodeTable.name,
              kind: GraphNodeTable.kind,
              startLine: GraphNodeTable.start_line,
              endLine: GraphNodeTable.end_line,
              signature: GraphNodeTable.signature,
            })
            .from(GraphNodeTable)
            .where(eq(GraphNodeTable.id, edge.sourceID))
            .get() as NodeResult | undefined

          if (node) results.push(node)
        }
      }
      return results
    })

    GraphCache.set(cacheKey, results)
    return results
  }

  /**
   * Finds all symbols called by a given function/method. Results are cached.
   *
   * @param projectID - Project scope
   * @param symbolName - Name of the calling function/method
   * @returns Nodes that are called by the source symbol
   */
  export function calleesOf(projectID: string, symbolName: string): NodeResult[] {
    const cacheKey = GraphCache.key(projectID, "calleesOf", symbolName)
    const cached = GraphCache.get<NodeResult[]>(cacheKey)
    if (cached) return cached

    const sources = findSymbol(projectID, symbolName)
    if (sources.length === 0) return []

    const sourceIDs = sources.map((s) => s.id)

    const results = Database.use((db) => {
      const results: NodeResult[] = []
      for (const sourceID of sourceIDs) {
        const edges = db
          .select({
            targetID: GraphEdgeTable.target_node_id,
          })
          .from(GraphEdgeTable)
          .where(
            and(
              eq(GraphEdgeTable.project_id, projectID),
              eq(GraphEdgeTable.source_node_id, sourceID),
              eq(GraphEdgeTable.kind, "calls"),
            ),
          )
          .all()

        for (const edge of edges) {
          const node = db
            .select({
              id: GraphNodeTable.id,
              filePath: GraphNodeTable.file_path,
              name: GraphNodeTable.name,
              kind: GraphNodeTable.kind,
              startLine: GraphNodeTable.start_line,
              endLine: GraphNodeTable.end_line,
              signature: GraphNodeTable.signature,
            })
            .from(GraphNodeTable)
            .where(eq(GraphNodeTable.id, edge.targetID))
            .get() as NodeResult | undefined

          if (node) results.push(node)
        }
      }
      return results
    })

    GraphCache.set(cacheKey, results)
    return results
  }

  /**
   * Finds all nodes in a given file.
   *
   * @param projectID - Project scope
   * @param filePath - Relative file path
   * @returns All nodes defined in the file
   */
  export function nodesInFile(projectID: string, filePath: string): NodeResult[] {
    return Database.use((db) =>
      db
        .select({
          id: GraphNodeTable.id,
          filePath: GraphNodeTable.file_path,
          name: GraphNodeTable.name,
          kind: GraphNodeTable.kind,
          startLine: GraphNodeTable.start_line,
          endLine: GraphNodeTable.end_line,
          signature: GraphNodeTable.signature,
        })
        .from(GraphNodeTable)
        .where(and(eq(GraphNodeTable.project_id, projectID), eq(GraphNodeTable.file_path, filePath)))
        .all() as NodeResult[],
    )
  }

  /**
   * Computes the impact of changing a symbol — finds all direct and
   * transitive dependents, affected tests, and affected files.
   *
   * @param projectID - Project scope
   * @param symbolName - Name of the symbol being changed
   * @param maxDepth - Maximum traversal depth for transitive dependents (default: 5)
   * @returns Impact analysis result
   */
  export function impactOf(projectID: string, symbolName: string, maxDepth = 5): ImpactResult {
    const cacheKey = GraphCache.key(projectID, "impactOf", symbolName, maxDepth)
    const cached = GraphCache.get<ImpactResult>(cacheKey)
    if (cached) return cached

    const directDependents = callersOf(projectID, symbolName)

    // BFS for transitive dependents
    const visited = new Set<string>()
    const transitiveDependents: NodeResult[] = []
    let frontier = directDependents.map((d) => d.name)

    for (const d of directDependents) {
      visited.add(d.id)
    }

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = []
      for (const name of frontier) {
        const callers = callersOf(projectID, name)
        for (const caller of callers) {
          if (!visited.has(caller.id)) {
            visited.add(caller.id)
            transitiveDependents.push(caller)
            nextFrontier.push(caller.name)
          }
        }
      }
      frontier = nextFrontier
    }

    // Find affected test files using multi-signal detection
    const allAffected = [...directDependents, ...transitiveDependents]
    const affectedTests = allAffected.filter((n) => isTestFile(n.filePath))

    const affectedFiles = [...new Set(allAffected.map((n) => n.filePath))]

    const result = {
      directDependents,
      transitiveDependents,
      affectedTests,
      affectedFiles,
    }

    GraphCache.set(cacheKey, result)
    return result
  }

  /**
   * Returns a high-level summary of the project's module structure.
   *
   * Groups nodes by file and reports counts per kind.
   *
   * @param projectID - Project scope
   * @returns Module summary with per-file entity counts
   */
  export function architecture(projectID: string): {
    files: { path: string; functions: number; classes: number; interfaces: number; types: number }[]
    totalNodes: number
    totalEdges: number
  } {
    const nodes = Database.use((db) =>
      db
        .select({
          filePath: GraphNodeTable.file_path,
          kind: GraphNodeTable.kind,
          count: sql<number>`count(*)`,
        })
        .from(GraphNodeTable)
        .where(eq(GraphNodeTable.project_id, projectID))
        .groupBy(GraphNodeTable.file_path, GraphNodeTable.kind)
        .all(),
    )

    const edgeCount = Database.use((db) =>
      db
        .select({
          count: sql<number>`count(*)`,
        })
        .from(GraphEdgeTable)
        .where(eq(GraphEdgeTable.project_id, projectID))
        .get(),
    )

    const fileMap = new Map<string, { functions: number; classes: number; interfaces: number; types: number }>()

    for (const row of nodes) {
      const entry = fileMap.get(row.filePath) ?? { functions: 0, classes: 0, interfaces: 0, types: 0 }
      switch (row.kind) {
        case "function":
        case "method":
          entry.functions += row.count
          break
        case "class":
          entry.classes += row.count
          break
        case "interface":
          entry.interfaces += row.count
          break
        case "type":
        case "enum":
          entry.types += row.count
          break
      }
      fileMap.set(row.filePath, entry)
    }

    const files = Array.from(fileMap.entries())
      .map(([path, counts]) => ({ path, ...counts }))
      .sort((a, b) => {
        const aTotal = a.functions + a.classes + a.interfaces + a.types
        const bTotal = b.functions + b.classes + b.interfaces + b.types
        return bTotal - aTotal
      })

    return {
      files,
      totalNodes: nodes.reduce((sum, r) => sum + r.count, 0),
      totalEdges: edgeCount?.count ?? 0,
    }
  }

  /**
   * Finds test files/functions that test a given symbol.
   *
   * Searches for nodes in test files that reference the symbol via edges.
   *
   * @param projectID - Project scope
   * @param symbolName - Symbol to find tests for
   * @returns Test-related nodes
   */
  export function relatedTests(projectID: string, symbolName: string): NodeResult[] {
    const impact = impactOf(projectID, symbolName, 2)
    return impact.affectedTests
  }

  /**
   * Determines if a file path is a test file using multi-signal detection.
   *
   * Checks:
   * - Suffix patterns: .test.ts, .spec.ts, _test.go, _test.py, test_*.py
   * - Directory conventions: test/, tests/, __tests__/, spec/
   * - Avoids false positives (e.g., "attestation.ts" won't match)
   *
   * @param filePath - Relative file path
   * @returns Whether the file is likely a test file
   */
  export function isTestFile(filePath: string): boolean {
    const basename = filePath.split("/").pop() ?? ""
    const ext = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")) : ""
    const nameWithoutExt = basename.slice(0, basename.length - ext.length)

    // Suffix patterns (most reliable)
    if (/\.(test|spec)\.\w+$/.test(basename)) return true       // .test.ts, .spec.js, etc.
    if (basename.endsWith("_test.go")) return true                // Go convention
    if (basename.endsWith("_test.py")) return true                // Python: foo_test.py
    if (basename.startsWith("test_") && ext === ".py") return true // Python: test_foo.py
    if (nameWithoutExt.endsWith("_test")) return true             // Generic: foo_test.rs, etc.
    if (nameWithoutExt.endsWith(".spec")) return true             // Alternative spec suffix

    // Directory conventions (with boundary check to avoid false positives)
    const parts = filePath.split("/")
    for (const part of parts) {
      if (part === "test" || part === "tests" || part === "__tests__" || part === "spec") {
        return true
      }
    }

    return false
  }

  // -------------------------------------------------------------------------
  // Centrality Scoring
  // -------------------------------------------------------------------------

  /**
   * Computes a centrality score for a symbol based on its inbound and outbound
   * edge counts. Uses a simplified PageRank-inspired formula:
   * score = log2(inbound + 1) * 0.6 + log2(outbound + 1) * 0.4
   *
   * Higher scores indicate more important/central symbols in the codebase.
   * Results are cached.
   *
   * @param projectID - Project scope
   * @param symbolName - Symbol to score
   * @returns Centrality score (0 = isolated, higher = more central)
   */
  export function centrality(projectID: string, symbolName: string): number {
    const cacheKey = GraphCache.key(projectID, "centrality", symbolName)
    const cached = GraphCache.get<number>(cacheKey)
    if (cached !== undefined) return cached

    const nodes = findSymbol(projectID, symbolName)
    if (nodes.length === 0) return 0

    let totalInbound = 0
    let totalOutbound = 0

    Database.use((db) => {
      for (const node of nodes) {
        const inbound = db
          .select({ count: sql<number>`count(*)` })
          .from(GraphEdgeTable)
          .where(
            and(
              eq(GraphEdgeTable.project_id, projectID),
              eq(GraphEdgeTable.target_node_id, node.id),
            ),
          )
          .get()
        totalInbound += inbound?.count ?? 0

        const outbound = db
          .select({ count: sql<number>`count(*)` })
          .from(GraphEdgeTable)
          .where(
            and(
              eq(GraphEdgeTable.project_id, projectID),
              eq(GraphEdgeTable.source_node_id, node.id),
            ),
          )
          .get()
        totalOutbound += outbound?.count ?? 0
      }
    })

    const score = Math.log2(totalInbound + 1) * 0.6 + Math.log2(totalOutbound + 1) * 0.4

    GraphCache.set(cacheKey, score)
    return score
  }

  /**
   * Computes centrality scores for all symbols in a project.
   * Returns a map of symbol name → centrality score.
   *
   * @param projectID - Project scope
   * @param limit - Maximum number of results (default: 100, sorted by score desc)
   */
  export function centralityRanking(
    projectID: string,
    limit: number = 100,
  ): { name: string; filePath: string; score: number }[] {
    const cacheKey = GraphCache.key(projectID, "centralityRanking", limit)
    const cached = GraphCache.get<{ name: string; filePath: string; score: number }[]>(cacheKey)
    if (cached) return cached

    // Get all nodes with their edge counts
    const nodes = Database.use((db) =>
      db
        .select({
          id: GraphNodeTable.id,
          name: GraphNodeTable.name,
          filePath: GraphNodeTable.file_path,
          kind: GraphNodeTable.kind,
        })
        .from(GraphNodeTable)
        .where(eq(GraphNodeTable.project_id, projectID))
        .all(),
    )

    // Count edges per node
    const inboundCounts = new Map<string, number>()
    const outboundCounts = new Map<string, number>()

    const edges = Database.use((db) =>
      db
        .select({
          sourceID: GraphEdgeTable.source_node_id,
          targetID: GraphEdgeTable.target_node_id,
        })
        .from(GraphEdgeTable)
        .where(eq(GraphEdgeTable.project_id, projectID))
        .all(),
    )

    for (const edge of edges) {
      outboundCounts.set(edge.sourceID, (outboundCounts.get(edge.sourceID) ?? 0) + 1)
      inboundCounts.set(edge.targetID, (inboundCounts.get(edge.targetID) ?? 0) + 1)
    }

    const results = nodes
      .filter((n) => n.kind !== "import" && n.kind !== "export")
      .map((node) => {
        const inbound = inboundCounts.get(node.id) ?? 0
        const outbound = outboundCounts.get(node.id) ?? 0
        const score = Math.log2(inbound + 1) * 0.6 + Math.log2(outbound + 1) * 0.4
        return { name: node.name, filePath: node.filePath, score }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    GraphCache.set(cacheKey, results)
    return results
  }

  // -------------------------------------------------------------------------
  // Graph statistics
  // -------------------------------------------------------------------------

  /**
   * Returns graph statistics for a project.
   */
  export function stats(projectID: string): {
    nodeCount: number
    edgeCount: number
    fileCount: number
    languages: string[]
  } {
    const nodeCount = Database.use((db) =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(GraphNodeTable)
        .where(eq(GraphNodeTable.project_id, projectID))
        .get(),
    )

    const edgeCount = Database.use((db) =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(GraphEdgeTable)
        .where(eq(GraphEdgeTable.project_id, projectID))
        .get(),
    )

    const fileCount = Database.use((db) =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(GraphFileStateTable)
        .where(eq(GraphFileStateTable.project_id, projectID))
        .get(),
    )

    // Infer languages from file extensions in the graph
    const files = Database.use((db) =>
      db
        .select({ filePath: GraphNodeTable.file_path })
        .from(GraphNodeTable)
        .where(eq(GraphNodeTable.project_id, projectID))
        .groupBy(GraphNodeTable.file_path)
        .all(),
    )

    const langs = new Set<string>()
    for (const f of files) {
      const lang = GraphParser.languageForFile(f.filePath)
      if (lang) langs.add(lang)
    }

    return {
      nodeCount: nodeCount?.count ?? 0,
      edgeCount: edgeCount?.count ?? 0,
      fileCount: fileCount?.count ?? 0,
      languages: [...langs],
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initializes the graph for the current project instance.
   *
   * Subscribes to file change events for incremental updates and
   * registers a scheduled task for periodic full re-index.
   */
  export async function init(): Promise<void> {
    const projectID = Instance.project.id
    const directory = Instance.worktree

    // Subscribe to file edit events for incremental updates + cache invalidation
    Bus.subscribe(File.Event.Edited, async (event) => {
      const filePath = event.properties.file

      // Invalidate query cache on any file edit
      GraphCache.invalidate(projectID)

      if (!GraphParser.isSupported(filePath)) return
      try {
        const count = await GraphBuilder.indexFile(filePath, projectID)
        if (count >= 0) {
          await Bus.publish(FileIndexed, {
            projectID,
            filePath,
            nodeCount: count,
          })
        }
      } catch (err) {
        log.warn("incremental index failed", {
          file: filePath,
          error: err,
        })
      }
    })

    // Register hourly full re-index
    Scheduler.register({
      id: "graph.reindex",
      interval: 60 * 60 * 1000,
      scope: "instance",
      async run() {
        await fullIndex(projectID, directory)
      },
    })

    log.info("graph initialized", { projectID })
  }

  /**
   * Runs a full project index with event publishing.
   *
   * @param projectID - Project identifier
   * @param directory - Project root directory
   */
  export async function fullIndex(projectID: string, directory: string) {
    const start = Date.now()

    await Bus.publish(IndexStarted, { projectID, directory })

    const result = await GraphBuilder.indexProject(projectID, directory)
    await GraphBuilder.resolveEdges(projectID)

    await Bus.publish(IndexComplete, {
      projectID,
      ...result,
      durationMs: Date.now() - start,
    })
  }

  /**
   * Clears all graph data for a project.
   *
   * @param projectID - Project identifier
   */
  export function clear(projectID: string): void {
    Database.transaction((tx) => {
      tx.delete(GraphEdgeTable).where(eq(GraphEdgeTable.project_id, projectID)).run()
      tx.delete(GraphNodeTable).where(eq(GraphNodeTable.project_id, projectID)).run()
      tx.delete(GraphFileStateTable).where(eq(GraphFileStateTable.project_id, projectID)).run()
    })
    log.info("graph cleared", { projectID })
  }
}

