import { $ } from "bun"
import { Database, eq, and } from "@/storage/db"
import { GraphNodeTable } from "./schema.sql"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { GraphCache } from "./cache"
import path from "path"

/**
 * Enriches graph nodes with git history metadata.
 *
 * Extracts per-file change frequency, last modification time, and
 * contributor counts from git log. This data helps the context pipeline
 * prioritize frequently-changed code (hotspots) and identify stable
 * vs volatile areas of the codebase.
 */
export namespace GitMetadata {
  const log = Log.create({ service: "graph.git-metadata" })

  export interface FileStats {
    filePath: string
    changeCount: number
    lastModified: number
    contributors: number
  }

  /**
   * Collects git change statistics for all files in the project.
   *
   * Uses `git log --name-only` to count commits per file and extract
   * last modification timestamps and unique contributor counts.
   *
   * @param directory - The project root directory (must be a git repo)
   * @param sinceDays - How far back to look in git history (default: 180 days)
   * @returns Map of relative file paths to their stats
   */
  export async function collectFileStats(
    directory: string,
    sinceDays = 180,
  ): Promise<Map<string, FileStats>> {
    // OPT-2.3: Cache git stats per directory with 5min TTL via GraphCache
    const cacheKey = GraphCache.key(directory, "gitFileStats", sinceDays)
    const cached = GraphCache.get<Map<string, FileStats>>(cacheKey)
    if (cached) return cached

    const stats = new Map<string, FileStats>()

    try {
      // Get commit count and last modified per file
      const result = await $`git log --since="${sinceDays} days ago" --name-only --pretty=format:"%at %ae" --diff-filter=AMRC`
        .cwd(directory)
        .quiet()
        .nothrow()
        .text()

      if (!result.trim()) return stats

      let currentTimestamp = 0
      let currentAuthor = ""

      const authorsByFile = new Map<string, Set<string>>()

      for (const line of result.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue

        // Lines starting with a digit are commit headers: "timestamp email"
        const headerMatch = /^(\d+)\s+(.+)$/.exec(trimmed)
        if (headerMatch) {
          currentTimestamp = parseInt(headerMatch[1], 10) * 1000
          currentAuthor = headerMatch[2]
          continue
        }

        // Otherwise it's a file path
        const filePath = trimmed
        const existing = stats.get(filePath)

        if (existing) {
          existing.changeCount++
          if (currentTimestamp > existing.lastModified) {
            existing.lastModified = currentTimestamp
          }
        } else {
          stats.set(filePath, {
            filePath,
            changeCount: 1,
            lastModified: currentTimestamp,
            contributors: 0,
          })
        }

        // Track unique authors
        const authors = authorsByFile.get(filePath) ?? new Set()
        if (currentAuthor) authors.add(currentAuthor)
        authorsByFile.set(filePath, authors)
      }

      // Set contributor counts
      for (const [filePath, authors] of authorsByFile) {
        const entry = stats.get(filePath)
        if (entry) entry.contributors = authors.size
      }
    } catch (err) {
      log.warn("failed to collect git stats", { error: err })
    }

    // OPT-2.3: Cache the result
    if (stats.size > 0) {
      GraphCache.set(cacheKey, stats)
    }

    return stats
  }

  /**
   * Identifies hotspot files — files with the most changes in recent history.
   *
   * @param directory - The project root directory
   * @param limit - Maximum number of hotspots to return (default: 20)
   * @param sinceDays - How far back to look (default: 180 days)
   * @returns Sorted array of file stats, most changed first
   */
  export async function hotspots(
    directory: string,
    limit = 20,
    sinceDays = 180,
  ): Promise<FileStats[]> {
    const stats = await collectFileStats(directory, sinceDays)
    return Array.from(stats.values())
      .sort((a, b) => b.changeCount - a.changeCount)
      .slice(0, limit)
  }

  /**
   * Gets git change statistics for a specific file.
   *
   * @param directory - The project root directory
   * @param filePath - Relative path to the file
   * @param sinceDays - How far back to look (default: 365 days)
   * @returns File stats or undefined if no history found
   */
  export async function fileStats(
    directory: string,
    filePath: string,
    sinceDays = 365,
  ): Promise<FileStats | undefined> {
    try {
      const result = await $`git log --since="${sinceDays} days ago" --pretty=format:"%at %ae" --follow -- ${filePath}`
        .cwd(directory)
        .quiet()
        .nothrow()
        .text()

      if (!result.trim()) return undefined

      const lines = result.trim().split("\n")
      const authors = new Set<string>()
      let lastModified = 0

      for (const line of lines) {
        const match = /^(\d+)\s+(.+)$/.exec(line.trim())
        if (match) {
          const ts = parseInt(match[1], 10) * 1000
          if (ts > lastModified) lastModified = ts
          authors.add(match[2])
        }
      }

      return {
        filePath,
        changeCount: lines.length,
        lastModified,
        contributors: authors.size,
      }
    } catch {
      return undefined
    }
  }

  /**
   * Gets the most recently changed functions/classes in the project.
   *
   * Combines git file stats with graph node data to identify which
   * code entities are in active development.
   *
   * @param projectID - The project ID for graph queries
   * @param directory - The project root directory
   * @param limit - Maximum results (default: 20)
   * @returns Array of {node, changeCount, lastModified} sorted by recency
   */
  export async function recentlyChangedEntities(
    projectID: string,
    directory: string,
    limit = 20,
  ): Promise<Array<{ name: string; kind: string; filePath: string; changeCount: number; lastModified: number }>> {
    const stats = await collectFileStats(directory, 90)

    // Get all graph nodes
    const nodes = Database.use((db) =>
      db
        .select({
          name: GraphNodeTable.name,
          kind: GraphNodeTable.kind,
          filePath: GraphNodeTable.file_path,
        })
        .from(GraphNodeTable)
        .where(eq(GraphNodeTable.project_id, projectID))
        .all(),
    )

    // Join nodes with git stats
    const enriched = nodes
      .map((node) => {
        const fileStats = stats.get(node.filePath)
        return {
          name: node.name,
          kind: node.kind,
          filePath: node.filePath,
          changeCount: fileStats?.changeCount ?? 0,
          lastModified: fileStats?.lastModified ?? 0,
        }
      })
      .filter((e) => e.changeCount > 0)
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, limit)

    return enriched
  }
}
