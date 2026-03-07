import { Database, eq, sql, inArray, or, and } from "@/storage/db"
import { GraphNodeTable, GraphEdgeTable } from "@/graph/schema.sql"
import { Graph } from "@/graph"
import { GitMetadata } from "@/graph/git-metadata"
import { GraphParser } from "@/graph/parser"
import { Token } from "@/util/token"
import { Log } from "@/util/log"
import { GraphCache } from "@/graph/cache"

/**
 * Scores code entities and files by relevance to a user query.
 *
 * Combines multiple signals: name matching, graph centrality,
 * git hotspot data, structural proximity, and recency of interaction.
 * Produces a ranked list of candidates for context packing.
 */
export namespace Scorer {
  const log = Log.create({ service: "context.scorer" })

  /** A scored candidate for inclusion in context. */
  export interface ScoredCandidate {
    /** Relative file path */
    filePath: string
    /** Symbol name (if entity-level, undefined for file-level) */
    name?: string
    /** Entity kind */
    kind?: string
    /** Line range for extraction */
    startLine?: number
    endLine?: number
    /** Signature for compact representation */
    signature?: string
    /** Composite relevance score (0-1) */
    score: number
    /** Breakdown of individual signal scores */
    signals: {
      nameMatch: number
      graphCentrality: number
      gitHotspot: number
      structuralProximity: number
      recency: number
    }
  }

  /** Weights for combining signals into final score. */
  export interface Weights {
    nameMatch: number
    graphCentrality: number
    gitHotspot: number
    structuralProximity: number
    recency: number
  }

  const DEFAULT_WEIGHTS: Weights = {
    nameMatch: 0.35,
    graphCentrality: 0.20,
    gitHotspot: 0.15,
    structuralProximity: 0.20,
    recency: 0.10,
  }

  /**
   * Scores all candidates relative to a set of seed entities and keywords.
   *
   * @param projectID - Project scope
   * @param directory - Project root directory
   * @param seeds - Initial seed data extracted from the user query
   * @param recentFiles - Files the user has recently interacted with
   * @param weights - Optional custom signal weights
   * @returns Sorted array of scored candidates (highest score first)
   */
  export async function score(
    projectID: string,
    directory: string,
    seeds: SeedData,
    recentFiles: string[],
    weights: Weights = DEFAULT_WEIGHTS,
  ): Promise<ScoredCandidate[]> {
    // OPT-2.2: Batch all 3 DB queries into a single Database.use() call
    const { allNodes, inboundMap, outboundMap } = Database.use((db) => {
      const allNodes = db
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
        .where(eq(GraphNodeTable.project_id, projectID))
        .all()

      const inboundCounts = db
        .select({
          nodeId: GraphEdgeTable.target_node_id,
          count: sql<number>`count(*)`,
        })
        .from(GraphEdgeTable)
        .where(eq(GraphEdgeTable.project_id, projectID))
        .groupBy(GraphEdgeTable.target_node_id)
        .all()

      const outboundCounts = db
        .select({
          nodeId: GraphEdgeTable.source_node_id,
          count: sql<number>`count(*)`,
        })
        .from(GraphEdgeTable)
        .where(eq(GraphEdgeTable.project_id, projectID))
        .groupBy(GraphEdgeTable.source_node_id)
        .all()

      return {
        allNodes,
        inboundMap: new Map(inboundCounts.map((e) => [e.nodeId, e.count])),
        outboundMap: new Map(outboundCounts.map((e) => [e.nodeId, e.count])),
      }
    })

    // Compute centrality: log2(inbound + 1) * 0.6 + log2(outbound + 1) * 0.4
    const centralityMap = new Map<string, number>()
    let maxCentrality = 0
    for (const node of allNodes) {
      const inbound = inboundMap.get(node.id) ?? 0
      const outbound = outboundMap.get(node.id) ?? 0
      const c = Math.log2(inbound + 1) * 0.6 + Math.log2(outbound + 1) * 0.4
      centralityMap.set(node.id, c)
      if (c > maxCentrality) maxCentrality = c
    }
    if (maxCentrality === 0) maxCentrality = 1

    // Git hotspot data
    let gitStats = new Map<string, GitMetadata.FileStats>()
    try {
      gitStats = await GitMetadata.collectFileStats(directory, 180)
    } catch {
      // Git data is optional — continue without it
    }
    const maxChanges = Math.max(1, ...Array.from(gitStats.values()).map((s) => s.changeCount))

    // Build structural proximity map — nodes reachable from seeds within 2 hops
    const seedNodeIds = new Set<string>()
    const proximityMap = new Map<string, number>() // nodeId → proximity score (1.0, 0.5, 0.25)

    for (const keyword of seeds.keywords) {
      const matches = allNodes.filter(
        (n) => n.name.toLowerCase() === keyword.toLowerCase(),
      )
      for (const m of matches) {
        seedNodeIds.add(m.id)
        proximityMap.set(m.id, 1.0)
      }
    }

    for (const filePath of seeds.filePaths) {
      const matches = allNodes.filter((n) => n.filePath === filePath || n.filePath.endsWith(filePath))
      for (const m of matches) {
        seedNodeIds.add(m.id)
        proximityMap.set(m.id, 1.0)
      }
    }

    // Expand 1-hop and 2-hop neighbors
    if (seedNodeIds.size > 0) {
      const hop1 = expandNeighbors(projectID, seedNodeIds)
      for (const id of hop1) {
        if (!proximityMap.has(id)) proximityMap.set(id, 0.5)
      }
      const hop2 = expandNeighbors(projectID, hop1)
      for (const id of hop2) {
        if (!proximityMap.has(id)) proximityMap.set(id, 0.25)
      }
    }

    // Recent files set for recency scoring
    const recentSet = new Set(recentFiles.map((f) => f.toLowerCase()))

    // Score each node
    const candidates: ScoredCandidate[] = allNodes.map((node) => {
      // Signal 1: Name match — does this node match any seed keyword?
      const nameMatch = computeNameMatch(node.name, node.filePath, seeds)

      // Signal 2: Graph centrality — PageRank-inspired score (inbound + outbound)
      const graphCentrality = (centralityMap.get(node.id) ?? 0) / maxCentrality

      // Signal 3: Git hotspot — how frequently changed is this file?
      const fileGit = gitStats.get(node.filePath)
      const gitHotspot = fileGit ? fileGit.changeCount / maxChanges : 0

      // Signal 4: Structural proximity — how close to seed nodes in the graph?
      const structuralProximity = proximityMap.get(node.id) ?? 0

      // Signal 5: Recency — has the user recently interacted with this file?
      const recency = recentSet.has(node.filePath.toLowerCase()) ? 1.0 : 0

      const signals = { nameMatch, graphCentrality, gitHotspot, structuralProximity, recency }
      const score =
        signals.nameMatch * weights.nameMatch +
        signals.graphCentrality * weights.graphCentrality +
        signals.gitHotspot * weights.gitHotspot +
        signals.structuralProximity * weights.structuralProximity +
        signals.recency * weights.recency

      return {
        filePath: node.filePath,
        name: node.name,
        kind: node.kind,
        startLine: node.startLine,
        endLine: node.endLine,
        signature: node.signature ?? undefined,
        score,
        signals,
      }
    })

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score)

    return candidates
  }

  /** Seed data extracted from the user's query. */
  export interface SeedData {
    /** Extracted symbol/entity names */
    keywords: string[]
    /** Extracted file paths */
    filePaths: string[]
    /** Raw query text for fuzzy matching */
    rawText: string
  }

  /**
   * Extracts seed data from a user message.
   *
   * Parses the message for file paths, symbol names, and keywords
   * that can be used to seed the relevance pipeline.
   *
   * @param text - The user's message text
   * @returns Extracted seed data
   */
  export function extractSeeds(text: string): SeedData {
    const keywords: string[] = []
    const filePaths: string[] = []

    // Extract file paths (patterns like src/foo/bar.ts, ./something.py, etc.)
    const filePathPattern = /(?:^|\s)((?:\.\/|\.\.\/|src\/|lib\/|test\/|packages\/)?[\w\-./]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|h|hpp|cs|php))\b/gi
    let match
    while ((match = filePathPattern.exec(text)) !== null) {
      filePaths.push(match[1].trim())
    }

    // Extract potential symbol names (CamelCase, snake_case identifiers)
    // Look for words that look like code identifiers
    const identifierPattern = /\b([A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*)\b/g
    while ((match = identifierPattern.exec(text)) !== null) {
      const word = match[1]
      // Skip common English words that happen to be capitalized
      if (!COMMON_WORDS.has(word.toLowerCase()) && word.length > 2) {
        keywords.push(word)
      }
    }

    // Look for backtick-quoted identifiers (e.g., `myFunction`, `MyClass`)
    const backtickPattern = /`([a-zA-Z_][\w.]*)`/g
    while ((match = backtickPattern.exec(text)) !== null) {
      keywords.push(match[1])
    }

    // Look for function-call patterns (e.g., "calls foo()", "function bar")
    const funcPattern = /(?:function|method|class|interface|type|def|fn|func)\s+(\w+)/gi
    while ((match = funcPattern.exec(text)) !== null) {
      keywords.push(match[1])
    }

    // Deduplicate
    return {
      keywords: [...new Set(keywords)],
      filePaths: [...new Set(filePaths)],
      rawText: text,
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Computes name match score for a node against seeds. */
  function computeNameMatch(
    nodeName: string,
    filePath: string,
    seeds: SeedData,
  ): number {
    const nameL = nodeName.toLowerCase()
    let best = 0

    // Exact keyword match
    for (const kw of seeds.keywords) {
      if (nameL === kw.toLowerCase()) {
        best = Math.max(best, 1.0)
      } else if (nameL.includes(kw.toLowerCase()) || kw.toLowerCase().includes(nameL)) {
        best = Math.max(best, 0.6)
      }
    }

    // File path match
    for (const fp of seeds.filePaths) {
      if (filePath === fp || filePath.endsWith(fp)) {
        best = Math.max(best, 0.8)
      } else if (filePath.includes(fp) || fp.includes(filePath)) {
        best = Math.max(best, 0.4)
      }
    }

    // Fuzzy: does the node name appear in the raw text?
    if (best === 0 && seeds.rawText.toLowerCase().includes(nameL) && nameL.length > 3) {
      best = 0.3
    }

    return best
  }

  /**
   * Expands a set of node IDs to include their 1-hop neighbors
   * (both callers and callees).
   *
   * OPT-2.1: Uses targeted SQL WHERE IN queries instead of full table scan.
   */
  function expandNeighbors(projectID: string, nodeIds: Set<string>): Set<string> {
    const neighbors = new Set<string>()
    if (nodeIds.size === 0) return neighbors

    const ids = [...nodeIds]

    // OPT-2.1: Query only edges that touch our seed nodes
    Database.use((db) => {
      const outgoing = db
        .select({ target: GraphEdgeTable.target_node_id })
        .from(GraphEdgeTable)
        .where(and(eq(GraphEdgeTable.project_id, projectID), inArray(GraphEdgeTable.source_node_id, ids)))
        .all()
      for (const e of outgoing) neighbors.add(e.target)

      const incoming = db
        .select({ source: GraphEdgeTable.source_node_id })
        .from(GraphEdgeTable)
        .where(and(eq(GraphEdgeTable.project_id, projectID), inArray(GraphEdgeTable.target_node_id, ids)))
        .all()
      for (const e of incoming) neighbors.add(e.source)
    })

    return neighbors
  }

  /** Common English words to exclude from identifier extraction. */
  const COMMON_WORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "her",
    "was", "one", "our", "out", "has", "his", "how", "its", "let", "may",
    "new", "now", "old", "see", "way", "who", "did", "get", "got", "had",
    "him", "use", "she", "too", "any", "fix", "add", "run", "set", "try",
    "also", "back", "been", "call", "come", "each", "find", "from",
    "give", "have", "help", "here", "just", "keep", "know", "last",
    "like", "look", "make", "many", "more", "most", "much", "must",
    "name", "need", "next", "only", "over", "part", "some", "such",
    "take", "tell", "than", "that", "them", "then", "they", "this",
    "time", "very", "want", "what", "when", "will", "with", "work",
    "would", "about", "after", "could", "every", "first", "found",
    "great", "never", "other", "place", "right", "shall", "should",
    "since", "still", "their", "there", "these", "thing", "think",
    "those", "under", "where", "which", "while", "world",
    "please", "change", "update", "create", "delete", "remove",
    "implement", "refactor", "ensure", "check", "write", "read",
  ])
}
