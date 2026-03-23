import { readFileSync } from "fs"
import { Log } from "@/util/log"
import { Token } from "@/util/token"
import type { RAG } from "./rag"
import { MetadataExtract } from "./metadata-extract"

/**
 * Format RAG search results into structured context for the LLM.
 *
 * Groups results by category (detection rules, exploits, writeups, code),
 * includes extracted metadata, and respects a token budget.
 * Produces a `<rag-context>` XML block optimized for local model consumption.
 */
export namespace RAGFormatter {
  const log = Log.create({ service: "embedding.format" })

  /** Category display names and sort priority (lower = shown first). */
  const CATEGORY_CONFIG: Record<string, { label: string; priority: number }> = {
    "detection-rule": { label: "Detection Rules", priority: 1 },
    "exploit": { label: "Exploit Code", priority: 2 },
    "writeup": { label: "Research & Writeups", priority: 3 },
    "code": { label: "Code", priority: 4 },
    "documentation": { label: "Documentation", priority: 5 },
    "config": { label: "Configuration", priority: 6 },
  }

  /**
   * Format search results into a structured `<rag-context>` block.
   *
   * Groups by category, includes metadata annotations, and enforces
   * a token budget. Higher-similarity results are prioritized across
   * all categories.
   *
   * @param results - Search results with optional metadata
   * @param maxTokens - Maximum token budget for the output
   * @returns Formatted XML string, or empty string if no results fit
   */
  export function formatResults(
    results: RAG.SearchResult[],
    maxTokens: number,
  ): string {
    if (results.length === 0) return ""

    // Read file content and extract metadata for each result
    const enriched: EnrichedResult[] = []
    for (const result of results) {
      const content = readChunkContent(result)
      if (!content) continue

      // Extract metadata from the actual content
      const meta = MetadataExtract.extract({
        content,
        filePath: result.filePath,
        relativePath: result.filePath,
        sourceRoot: "",
        startLine: result.startLine,
        endLine: result.endLine,
        type: "code",
        extension: extractExtension(result.filePath),
        chunkID: result.chunkID,
      })

      enriched.push({
        ...result,
        content,
        metadata: meta,
        category: meta.category,
      })
    }

    if (enriched.length === 0) return ""

    // Sort by similarity descending (best matches first for budget allocation)
    enriched.sort((a, b) => b.similarity - a.similarity)

    // Deduplicate: keep only the highest-scoring chunk per file path.
    // Multiple chunks from the same file waste tokens on redundant content.
    const seenFiles = new Set<string>()
    const deduped: EnrichedResult[] = []
    for (const result of enriched) {
      if (seenFiles.has(result.filePath)) continue
      seenFiles.add(result.filePath)
      deduped.push(result)
    }

    // For small files (detection rules, configs), show full content instead of
    // just the chunk's line range. This ensures complete rules are visible.
    for (const result of deduped) {
      if (isSmallFile(result.filePath)) {
        const full = readFullFile(result.filePath)
        if (full) {
          result.content = full.content
          result.startLine = 1
          result.endLine = full.lineCount
        }
      }
    }

    // Allocate results within token budget
    const selected: EnrichedResult[] = []
    let totalTokens = 50 // Reserve for XML tags and headers
    for (const result of deduped) {
      const entryTokens = Token.estimate(formatEntry(result))
      if (totalTokens + entryTokens > maxTokens) continue
      selected.push(result)
      totalTokens += entryTokens
    }

    if (selected.length === 0) return ""

    // Group by category
    const groups = new Map<string, EnrichedResult[]>()
    for (const result of selected) {
      const existing = groups.get(result.category) ?? []
      existing.push(result)
      groups.set(result.category, existing)
    }

    // Sort groups by priority
    const sortedGroups = [...groups.entries()].sort((a, b) => {
      const pa = CATEGORY_CONFIG[a[0]]?.priority ?? 99
      const pb = CATEGORY_CONFIG[b[0]]?.priority ?? 99
      return pa - pb
    })

    // Build output
    const parts: string[] = ["<rag-context>"]

    for (const [category, results] of sortedGroups) {
      const config = CATEGORY_CONFIG[category] ?? { label: category, priority: 99 }
      parts.push(`\n## ${config.label}`)

      for (const result of results) {
        parts.push(formatEntry(result))
      }
    }

    parts.push("\n</rag-context>")

    const output = parts.join("\n")
    log.info("RAG context formatted", {
      results: enriched.length,
      selected: selected.length,
      groups: sortedGroups.length,
      tokens: Token.estimate(output),
      files: selected.map(r => `${r.filePath}:${r.startLine}-${r.endLine}(${r.category})`),
      skipped: deduped.filter(r => !selected.includes(r)).map(r => `${r.filePath}(${Token.estimate(formatEntry(r))}tok)`),
    })

    return output
  }

  // ── Internal helpers ──

  interface EnrichedResult extends RAG.SearchResult {
    content: string
    metadata: MetadataExtract.ChunkMetadata
    category: string
  }

  /**
   * Format a single result entry with metadata header.
   */
  function formatEntry(result: EnrichedResult): string {
    const header = `── ${result.filePath}:${result.startLine}-${result.endLine} (${(result.similarity * 100).toFixed(0)}% match) ──`
    const metaLine = MetadataExtract.formatForDisplay(result.metadata)
    const parts = [header]
    if (metaLine) parts.push(metaLine)
    parts.push(result.content)
    return parts.join("\n")
  }

  /**
   * Read chunk content from the file by line range.
   */
  function readChunkContent(result: RAG.SearchResult): string | null {
    try {
      const fileContent = readFileSync(result.filePath, "utf-8")
      const lines = fileContent.split("\n")
      const start = Math.max(0, result.startLine - 1)
      const end = Math.min(lines.length, result.endLine)
      return lines.slice(start, end).join("\n")
    } catch {
      return null
    }
  }

  /**
   * Extract file extension from a path.
   */
  function extractExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf(".")
    if (lastDot === -1) return ""
    return filePath.slice(lastDot).toLowerCase()
  }

  /** File extensions considered small enough to include in full. */
  const SMALL_FILE_EXTS = new Set([
    ".rule", ".rules", ".yar", ".yara", ".sigma",
    ".snort", ".suricata", ".conf", ".cfg",
  ])

  /** Max file size (chars) to include in full. */
  const SMALL_FILE_MAX = 4000

  /**
   * Check if a file is small enough to include its full content.
   */
  function isSmallFile(filePath: string): boolean {
    const ext = extractExtension(filePath)
    if (SMALL_FILE_EXTS.has(ext)) return true
    // Also treat any .rule-like file as small
    if (filePath.includes(".snort.") || filePath.includes(".suricata.")) return true
    return false
  }

  /**
   * Read the full content of a small file.
   */
  function readFullFile(filePath: string): { content: string; lineCount: number } | null {
    try {
      const content = readFileSync(filePath, "utf-8")
      if (content.length > SMALL_FILE_MAX) return null
      return { content, lineCount: content.split("\n").length }
    } catch {
      return null
    }
  }
}
