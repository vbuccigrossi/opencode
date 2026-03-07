import { Log } from "../util/log"
import fs from "fs/promises"
import path from "path"

/**
 * Documentation-aware search.
 *
 * Searches across documentation files (README, docs/, comments, docstrings)
 * with TF-IDF-based relevance scoring. Provides symbol-specific documentation
 * lookup that combines inline docs, README mentions, and test descriptions.
 */
export namespace DocSearch {
  const log = Log.create({ service: "search.docs" })

  /** A search result. */
  export interface Result {
    file: string
    line: number
    score: number
    snippet: string
    source: "readme" | "docs" | "comment" | "changelog" | "test"
  }

  /** Documentation index for a directory. */
  export interface DocIndex {
    files: IndexedFile[]
    builtAt: number
  }

  interface IndexedFile {
    path: string
    source: Result["source"]
    sections: Section[]
  }

  interface Section {
    heading: string
    startLine: number
    content: string
    terms: Map<string, number>
  }

  /** Documentation file patterns and their source types. */
  const DOC_PATTERNS: [RegExp, Result["source"]][] = [
    [/^readme(\.\w+)?$/i, "readme"],
    [/^contributing(\.\w+)?$/i, "docs"],
    [/^changelog(\.\w+)?$/i, "changelog"],
    [/^history(\.\w+)?$/i, "changelog"],
    [/^changes(\.\w+)?$/i, "changelog"],
    [/^docs?\//i, "docs"],
    [/^documentation\//i, "docs"],
    [/^wiki\//i, "docs"],
    [/^guides?\//i, "docs"],
    [/\.md$/i, "docs"],
    [/\.rst$/i, "docs"],
    [/\.txt$/i, "docs"],
  ]

  // OPT-3.3: Module-level index cache with TTL
  const indexCache = new Map<string, { index: DocIndex; timestamp: number }>()
  const INDEX_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  /** Paths to skip during indexing. */
  const SKIP_PATHS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    "__pycache__",
    "venv",
    ".venv",
    "target",
    ".opencode",
    ".claude",
  ])

  /**
   * Tokenize text into lowercase terms.
   */
  function tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  }

  /**
   * Compute term frequencies for a text.
   */
  function termFrequencies(text: string): Map<string, number> {
    const terms = tokenize(text)
    const freq = new Map<string, number>()
    for (const t of terms) {
      freq.set(t, (freq.get(t) ?? 0) + 1)
    }
    return freq
  }

  /**
   * Split a document into sections by headings.
   */
  function splitSections(content: string, filePath: string): Section[] {
    const lines = content.split("\n")
    const sections: Section[] = []
    let currentHeading = path.basename(filePath)
    let currentStart = 1
    let currentLines: string[] = []

    for (let i = 0; i < lines.length; i++) {
      const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/)
      if (headingMatch) {
        // Save previous section
        if (currentLines.length > 0) {
          const content = currentLines.join("\n")
          sections.push({
            heading: currentHeading,
            startLine: currentStart,
            content,
            terms: termFrequencies(content),
          })
        }
        currentHeading = headingMatch[2]
        currentStart = i + 1
        currentLines = []
      } else {
        currentLines.push(lines[i])
      }
    }

    // Last section
    if (currentLines.length > 0) {
      const content = currentLines.join("\n")
      sections.push({
        heading: currentHeading,
        startLine: currentStart,
        content,
        terms: termFrequencies(content),
      })
    }

    return sections
  }

  /**
   * Classify a file path into a documentation source type.
   */
  function classifyFile(filePath: string, relativePath: string): Result["source"] | null {
    for (const [pattern, source] of DOC_PATTERNS) {
      if (pattern.test(relativePath) || pattern.test(path.basename(filePath))) {
        return source
      }
    }
    // Check for test descriptions
    if (/\.(test|spec)\.[jt]sx?$|__tests__|_test\.|test_/i.test(filePath)) {
      return "test"
    }
    return null
  }

  /**
   * Build a documentation index for a directory.
   *
   * @param directory - Root directory to index
   * @param maxFiles - Maximum files to index (default 500)
   * @returns Documentation index
   */
  export async function index(directory: string, maxFiles = 500): Promise<DocIndex> {
    // OPT-3.3: Return cached index if fresh
    const cached = indexCache.get(directory)
    if (cached && Date.now() - cached.timestamp < INDEX_CACHE_TTL) {
      return cached.index
    }

    const files: IndexedFile[] = []

    // OPT-3.1: Collect paths first, then batch-read concurrently
    const docFiles: { path: string; source: Result["source"] }[] = []

    const walk = async (dir: string) => {
      if (docFiles.length >= maxFiles) return
      let entries: import("fs").Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (docFiles.length >= maxFiles) break
        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(directory, fullPath)

        if (entry.isDirectory()) {
          if (!SKIP_PATHS.has(entry.name)) {
            await walk(fullPath)
          }
        } else if (entry.isFile()) {
          const source = classifyFile(fullPath, relativePath)
          if (source) docFiles.push({ path: fullPath, source })
        }
      }
    }

    await walk(directory)

    // Batch-read files concurrently
    const CONCURRENCY = 20
    for (let i = 0; i < docFiles.length; i += CONCURRENCY) {
      const batch = docFiles.slice(i, i + CONCURRENCY)
      const reads = await Promise.all(
        batch.map(async (df) => {
          try {
            const content = await fs.readFile(df.path, "utf-8")
            return { ...df, content }
          } catch {
            return null
          }
        }),
      )
      for (const r of reads) {
        if (!r) continue
        const sections = splitSections(r.content, r.path)
        if (sections.length > 0) {
          files.push({ path: r.path, source: r.source, sections })
        }
      }
    }
    log.info("indexed", { directory, files: files.length })
    const result: DocIndex = { files, builtAt: Date.now() }

    // OPT-3.3: Cache the index
    indexCache.set(directory, { index: result, timestamp: Date.now() })
    return result
  }

  /** Invalidate cached doc index for a directory. */
  export function invalidateIndex(directory: string): void {
    indexCache.delete(directory)
  }

  /**
   * Search documentation with TF-IDF relevance scoring.
   *
   * @param docIndex - Pre-built documentation index
   * @param query - Search query
   * @param maxResults - Maximum results to return (default 10)
   * @returns Scored search results
   */
  export function search(docIndex: DocIndex, query: string, maxResults = 10): Result[] {
    const queryTerms = tokenize(query)
    if (queryTerms.length === 0) return []

    // Compute IDF across all sections
    const totalSections = docIndex.files.reduce((sum, f) => sum + f.sections.length, 0)
    const docFreq = new Map<string, number>()
    for (const file of docIndex.files) {
      for (const section of file.sections) {
        for (const term of section.terms.keys()) {
          docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
        }
      }
    }

    const results: Result[] = []

    for (const file of docIndex.files) {
      for (const section of file.sections) {
        let score = 0

        for (const qt of queryTerms) {
          const tf = section.terms.get(qt) ?? 0
          if (tf === 0) continue

          const df = docFreq.get(qt) ?? 1
          const idf = Math.log(1 + totalSections / df)
          score += tf * idf
        }

        if (score === 0) continue

        // Source priority boost
        const sourceBoost: Record<Result["source"], number> = {
          readme: 1.5,
          docs: 1.3,
          changelog: 1.0,
          comment: 0.9,
          test: 0.8,
        }
        score *= sourceBoost[file.source] ?? 1.0

        // Extract snippet (first few lines containing a query term)
        const snippet = extractSnippet(section.content, queryTerms)

        results.push({
          file: file.path,
          line: section.startLine,
          score: Math.round(score * 100) / 100,
          snippet,
          source: file.source,
        })
      }
    }

    // Sort by score descending, take top N
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, maxResults)
  }

  /**
   * Find documentation for a specific symbol.
   *
   * Searches across all documentation sources for mentions of the symbol
   * and returns combined results.
   *
   * @param docIndex - Pre-built documentation index
   * @param symbol - Symbol name to look up
   * @returns Aggregated documentation snippets
   */
  export function explain(docIndex: DocIndex, symbol: string): Result[] {
    // Search for the symbol name and common variations
    const variations = [symbol, symbol.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()]
    const uniqueQuery = [...new Set(variations)].join(" ")

    const results = search(docIndex, uniqueQuery, 15)

    // Also do exact string match for higher precision
    const exactResults: Result[] = []
    for (const file of docIndex.files) {
      for (const section of file.sections) {
        if (section.content.includes(symbol)) {
          const snippet = extractSnippet(section.content, [symbol])
          const existing = results.find((r) => r.file === file.path && r.line === section.startLine)
          if (existing) {
            existing.score *= 1.5 // Boost exact matches
          } else {
            exactResults.push({
              file: file.path,
              line: section.startLine,
              score: 5.0,
              snippet,
              source: file.source,
            })
          }
        }
      }
    }

    const combined = [...results, ...exactResults]
    combined.sort((a, b) => b.score - a.score)
    return combined.slice(0, 10)
  }

  /**
   * Extract a relevant snippet from content based on query terms.
   */
  function extractSnippet(content: string, queryTerms: string[], maxLength = 200): string {
    const lines = content.split("\n")
    const lowerTerms = queryTerms.map((t) => t.toLowerCase())

    // Find the first line containing a query term
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase()
      if (lowerTerms.some((t) => lower.includes(t))) {
        // Return this line and the next few
        const snippet = lines
          .slice(i, i + 3)
          .join("\n")
          .trim()
        return snippet.length > maxLength ? snippet.substring(0, maxLength) + "..." : snippet
      }
    }

    // Fallback: first non-empty lines
    const nonEmpty = lines.filter((l) => l.trim())
    const snippet = nonEmpty.slice(0, 2).join("\n").trim()
    return snippet.length > maxLength ? snippet.substring(0, maxLength) + "..." : snippet
  }

  /** Format search results. */
  export function format(results: Result[], relativeTo?: string): string {
    if (results.length === 0) return "No documentation found."

    return results
      .map((r) => {
        const file = relativeTo ? path.relative(relativeTo, r.file) : r.file
        return `[${r.source}] ${file}:${r.line} (score: ${r.score})\n  ${r.snippet}`
      })
      .join("\n\n")
  }
}
