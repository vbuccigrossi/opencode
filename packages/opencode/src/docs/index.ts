import { Log } from "@/util/log"
import { DtsParser } from "./dts-parser"
import { readFile, readdir, access } from "fs/promises"
import { join } from "path"

/**
 * Documentation retrieval engine — indexes type declarations from
 * installed packages and provides fast symbol lookup.
 *
 * Instead of guessing at API signatures from training data, the agent
 * can look up the exact type info from the installed package version.
 */
export namespace Docs {
  const log = Log.create({ service: "docs" })

  /** Re-export TypeInfo. */
  export type TypeInfo = DtsParser.TypeInfo

  /** Indexed symbols, keyed by symbol name. */
  const index = new Map<string, TypeInfo[]>()

  /** Indexed packages (to avoid re-indexing). */
  const indexedPackages = new Set<string>()

  /** Cache TTL tracking. */
  const indexTimes = new Map<string, number>()
  const INDEX_TTL = 300_000 // 5 minutes

  /**
   * Index a package's type declarations.
   *
   * Reads .d.ts files from node_modules/<package>/ and extracts
   * all exported symbols.
   *
   * @param packageName - Package name (e.g., "zod", "express")
   * @param cwd - Project root directory
   * @returns Number of symbols indexed
   */
  export async function indexPackage(packageName: string, cwd: string): Promise<number> {
    // Check cache
    const cacheTime = indexTimes.get(packageName) ?? 0
    if (indexedPackages.has(packageName) && Date.now() - cacheTime < INDEX_TTL) {
      return 0 // Already indexed
    }

    const pkgDir = join(cwd, "node_modules", packageName)
    let count = 0

    try {
      await access(pkgDir)
    } catch {
      log.warn("package not found in node_modules", { packageName })
      return 0
    }

    // Find .d.ts files
    const dtsFiles = await findDtsFiles(pkgDir)

    for (const dtsFile of dtsFiles.slice(0, 20)) {
      // Cap per package
      try {
        const content = await readFile(dtsFile, "utf-8")
        const types = DtsParser.parse(content, packageName)

        for (const info of types) {
          const existing = index.get(info.name) ?? []
          // Avoid duplicates from same package
          if (!existing.some((e) => e.source === info.source && e.signature === info.signature)) {
            existing.push(info)
            index.set(info.name, existing)
            count++
          }
        }
      } catch (err: any) {
        log.warn("failed to parse dts file", { file: dtsFile, error: err.message })
      }
    }

    indexedPackages.add(packageName)
    indexTimes.set(packageName, Date.now())
    log.info("package indexed", { packageName, symbols: count, files: dtsFiles.length })

    return count
  }

  /**
   * Look up a symbol's type info.
   *
   * @param symbol - Symbol name to look up
   * @param packageName - Optional package filter
   * @returns Matching type info entries
   */
  export function lookup(symbol: string, packageName?: string): TypeInfo[] {
    const results = index.get(symbol) ?? []
    if (packageName) {
      return results.filter((r) => r.source === packageName)
    }
    return results
  }

  /**
   * Search for symbols matching a pattern.
   *
   * @param query - Search query (prefix match)
   * @param maxResults - Maximum results (default: 10)
   * @returns Matching type info entries
   */
  export function search(query: string, maxResults: number = 10): TypeInfo[] {
    const results: TypeInfo[] = []
    const lowerQuery = query.toLowerCase()

    for (const [name, infos] of index) {
      if (name.toLowerCase().startsWith(lowerQuery) || name.toLowerCase().includes(lowerQuery)) {
        results.push(...infos)
        if (results.length >= maxResults) break
      }
    }

    return results.slice(0, maxResults)
  }

  /**
   * Format type info for context injection or tool output.
   *
   * @param infos - Type info entries to format
   * @param maxChars - Maximum characters (default: 1000)
   * @returns Formatted string
   */
  export function format(infos: TypeInfo[], maxChars: number = 1000): string {
    if (infos.length === 0) return "No matching types found."

    const lines: string[] = []
    let total = 0

    for (const info of infos) {
      const line = formatOne(info)
      if (total + line.length + 2 > maxChars) break
      lines.push(line)
      total += line.length + 1
    }

    return lines.join("\n")
  }

  /**
   * Get index statistics.
   */
  export function stats(): { packages: number; symbols: number } {
    return {
      packages: indexedPackages.size,
      symbols: index.size,
    }
  }

  /**
   * Clear the entire index.
   */
  export function clearIndex(): void {
    index.clear()
    indexedPackages.clear()
    indexTimes.clear()
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Find .d.ts files in a package directory. */
  async function findDtsFiles(dir: string, depth: number = 0): Promise<string[]> {
    if (depth > 3) return [] // Don't go too deep

    const results: string[] = []

    try {
      const entries = await readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)

        if (entry.isFile() && entry.name.endsWith(".d.ts")) {
          results.push(fullPath)
        } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          const subResults = await findDtsFiles(fullPath, depth + 1)
          results.push(...subResults)
        }
      }
    } catch {}

    return results
  }

  /** Format a single TypeInfo entry. */
  function formatOne(info: TypeInfo): string {
    const parts: string[] = []

    parts.push(`[${info.source}] ${info.kind} ${info.name}`)
    if (info.signature) parts.push(`  ${info.signature}`)
    if (info.description) parts.push(`  ${info.description}`)

    if (info.parameters && info.parameters.length > 0) {
      for (const param of info.parameters) {
        const opt = param.optional ? "?" : ""
        const desc = param.description ? ` — ${param.description}` : ""
        parts.push(`    ${param.name}${opt}: ${param.type}${desc}`)
      }
    }

    if (info.returnType) {
      parts.push(`  → ${info.returnType}`)
    }

    return parts.join("\n")
  }
}
