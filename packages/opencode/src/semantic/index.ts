import { Log } from "@/util/log"
import { Heuristics } from "./heuristics"
import { readFile } from "fs/promises"
import { relative } from "path"

/**
 * Semantic code summary engine — generates and caches behavioral
 * descriptions of functions, classes, and modules.
 *
 * Uses heuristic extraction (no LLM calls) to analyze source code
 * and produce concise summaries describing what code does, its inputs/
 * outputs, side effects, and error conditions.
 */
export namespace Semantic {
  const log = Log.create({ service: "semantic" })

  /** A semantic summary of a code symbol. */
  export interface Summary {
    /** Symbol name. */
    symbol: string
    /** File path. */
    filePath: string
    /** Symbol kind. */
    kind: "function" | "class" | "module" | "namespace"
    /** 1-2 sentence behavioral description. */
    behavior: string
    /** Parameter descriptions. */
    inputs: string[]
    /** Return type/value description. */
    outputs: string
    /** Detected side effects. */
    sideEffects: string[]
    /** Error conditions. */
    throws: string[]
    /** Complexity level. */
    complexity: "simple" | "moderate" | "complex"
  }

  /** Cache of summaries keyed by "filePath:symbolName". */
  const cache = new Map<string, Summary>()

  /** Cache TTL in ms (10 minutes). */
  const CACHE_TTL = 600_000
  const cacheTimes = new Map<string, number>()

  /**
   * Generate a summary for a symbol from its source code.
   *
   * @param filePath - File containing the symbol
   * @param symbolName - Name of the function/class/namespace
   * @param source - Source code of the symbol
   * @param precedingComment - Optional comment block before the symbol
   * @returns Generated summary
   */
  export function summarize(
    filePath: string,
    symbolName: string,
    source: string,
    precedingComment?: string,
  ): Summary {
    const cacheKey = `${filePath}:${symbolName}`

    // Check cache
    const cached = cache.get(cacheKey)
    const cacheTime = cacheTimes.get(cacheKey) ?? 0
    if (cached && Date.now() - cacheTime < CACHE_TTL) {
      return cached
    }

    const signals = Heuristics.extract(source, precedingComment)
    const kind = detectKind(source)
    const behavior = Heuristics.summarize(symbolName, kind, signals)

    const complexityScore = signals.complexity
    let complexity: Summary["complexity"] = "simple"
    const score = complexityScore.lines * 0.1 + complexityScore.branches * 2 +
      complexityScore.loops * 3 + complexityScore.tryCatch * 1
    if (score >= 15) complexity = "complex"
    else if (score >= 5) complexity = "moderate"

    const summary: Summary = {
      symbol: symbolName,
      filePath,
      kind,
      behavior,
      inputs: signals.params.map((p) => {
        const opt = p.optional ? "?" : ""
        return p.type ? `${p.name}${opt}: ${p.type}` : `${p.name}${opt}`
      }),
      outputs: signals.returnType ?? "void",
      sideEffects: signals.sideEffects,
      throws: signals.throws,
      complexity,
    }

    cache.set(cacheKey, summary)
    cacheTimes.set(cacheKey, Date.now())

    return summary
  }

  /**
   * Get a cached summary.
   *
   * @param filePath - File path
   * @param symbolName - Symbol name
   * @returns Cached summary, or undefined
   */
  export function get(filePath: string, symbolName: string): Summary | undefined {
    const cacheKey = `${filePath}:${symbolName}`
    const cached = cache.get(cacheKey)
    const cacheTime = cacheTimes.get(cacheKey) ?? 0
    if (cached && Date.now() - cacheTime < CACHE_TTL) {
      return cached
    }
    return undefined
  }

  /**
   * Summarize all exported symbols in a file.
   *
   * Parses the file to find exported functions, classes, namespaces,
   * and generates summaries for each.
   *
   * @param filePath - Absolute path to the file
   * @returns Array of summaries
   */
  export async function summarizeFile(filePath: string): Promise<Summary[]> {
    const content = await readFile(filePath, "utf-8")
    const symbols = extractSymbols(content)
    const summaries: Summary[] = []

    for (const sym of symbols) {
      summaries.push(
        summarize(filePath, sym.name, sym.source, sym.comment),
      )
    }

    log.info("file summarized", { filePath, symbols: summaries.length })
    return summaries
  }

  /**
   * Format summaries for context injection.
   *
   * @param summaries - Summaries to format
   * @param cwd - Optional cwd for relative paths
   * @param maxChars - Maximum characters (default: 1000)
   * @returns Formatted `<semantic>` block
   */
  export function format(
    summaries: Summary[],
    cwd?: string,
    maxChars: number = 1000,
  ): string {
    if (summaries.length === 0) return ""

    const lines: string[] = ["<semantic>"]
    let totalLength = 12

    for (const s of summaries) {
      const path = cwd ? relative(cwd, s.filePath) : s.filePath
      const line = `  ${path}:${s.symbol} — ${s.behavior}`
      if (totalLength + line.length + 2 > maxChars) break
      lines.push(line)
      totalLength += line.length + 1
    }

    lines.push("</semantic>")
    return lines.join("\n")
  }

  /**
   * Get cache statistics.
   */
  export function cacheStats(): { size: number } {
    return { size: cache.size }
  }

  /**
   * Clear all cached summaries.
   */
  export function clearCache(): void {
    cache.clear()
    cacheTimes.clear()
  }

  /**
   * Invalidate cache for a specific file (e.g., after edit).
   *
   * @param filePath - File whose summaries should be invalidated
   */
  export function invalidate(filePath: string): void {
    for (const key of cache.keys()) {
      if (key.startsWith(filePath + ":")) {
        cache.delete(key)
        cacheTimes.delete(key)
      }
    }
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Detect the kind of a symbol from its source. */
  function detectKind(source: string): Summary["kind"] {
    const firstLine = source.trim().split("\n")[0] ?? ""
    if (/\bclass\b/.test(firstLine)) return "class"
    if (/\bnamespace\b/.test(firstLine)) return "namespace"
    if (/\bfunction\b/.test(firstLine) || /=>\s*/.test(firstLine)) return "function"
    if (/\bmodule\b/.test(firstLine)) return "module"
    return "function"
  }

  /** Extract exported symbols and their source from file content. */
  function extractSymbols(content: string): Array<{
    name: string
    source: string
    comment?: string
  }> {
    const symbols: Array<{ name: string; source: string; comment?: string }> = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Match exported declarations
      const exportMatch = line.match(
        /^\s*export\s+(?:async\s+)?(?:function|class|namespace|const|let|enum|interface|type)\s+(\w+)/,
      )

      if (exportMatch) {
        const name = exportMatch[1]

        // Collect preceding comment
        let comment: string | undefined
        let commentStart = i - 1
        while (commentStart >= 0 && /^\s*(\/\/|\*|\/\*\*)/.test(lines[commentStart])) {
          commentStart--
        }
        if (commentStart < i - 1) {
          comment = lines.slice(commentStart + 1, i).join("\n")
        }

        // Collect the symbol's source (up to next export or end of indentation)
        const sourceLines = [line]
        let depth = 0
        for (const ch of line) {
          if (ch === "{") depth++
          if (ch === "}") depth--
        }

        let j = i + 1
        while (j < lines.length && depth > 0) {
          const srcLine = lines[j]
          sourceLines.push(srcLine)
          for (const ch of srcLine) {
            if (ch === "{") depth++
            if (ch === "}") depth--
          }
          j++
        }

        // For single-line declarations (const, type, interface without body)
        if (sourceLines.length === 1 && depth === 0) {
          // Include a few more lines for multi-line declarations
          while (j < lines.length && j < i + 10) {
            const nextLine = lines[j].trim()
            if (nextLine === "" || nextLine.startsWith("export ") || nextLine.startsWith("//")) break
            sourceLines.push(lines[j])
            j++
          }
        }

        symbols.push({
          name,
          source: sourceLines.join("\n"),
          comment,
        })
      }
    }

    return symbols
  }
}
