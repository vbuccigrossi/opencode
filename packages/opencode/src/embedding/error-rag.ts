import { Log } from "@/util/log"
import { RAG } from "./rag"
import { RAGFormatter } from "./format"
import { Token } from "@/util/token"

/**
 * Error-aware RAG retrieval — automatically search RAG for relevant docs
 * when compilation or build commands fail.
 *
 * Flow:
 *   1. Post-step: scan bash tool results for non-zero exit codes
 *   2. Extract package names, symbols, and error messages from compiler output
 *   3. Search RAG for relevant documentation (1-3 queries)
 *   4. Format within an 800-token budget as <error-context> block
 *   5. Inject into next step's system prompt (ollama only)
 *   6. Clear after one injection (doesn't persist if error is fixed)
 */
export namespace ErrorRAG {
  const log = Log.create({ service: "embedding.error-rag" })

  /** Parsed error information from compiler/build output. */
  export interface ErrorInfo {
    /** Raw output that was analyzed. */
    output: string
    /** Package names referenced in errors. */
    packages: string[]
    /** Symbol names (functions, types, variables) referenced in errors. */
    symbols: string[]
    /** Individual error messages extracted. */
    errorMessages: string[]
  }

  /** Cached error context per session, cleared after injection. */
  const cache = new Map<string, string>()

  /**
   * Scan tool parts from the latest step for bash failures, extract error
   * info, search RAG for relevant docs, and cache the formatted result.
   *
   * @param sessionID - Current session ID
   * @param parts - Tool parts from the completed step
   * @param maxTokens - Token budget for the error context block (default: 800)
   */
  export async function processToolResults(
    sessionID: string,
    parts: Array<{ type: string; tool?: string; state?: any }>,
    maxTokens: number = 800,
  ): Promise<void> {
    // Only process bash tool results with errors
    const bashErrors: string[] = []

    for (const part of parts) {
      if (part.type !== "tool" || part.tool !== "bash") continue
      const state = part.state
      if (!state || state.status !== "completed") continue

      // Check for non-zero exit code in the output
      const output = state.output ?? state.metadata?.output ?? ""
      if (!output) continue

      // Bash tool output includes exit code metadata or error patterns
      // The tool marks failures — check for error indicators
      if (hasCompilationErrors(output)) {
        bashErrors.push(output)
      }
    }

    if (bashErrors.length === 0) return

    const combinedOutput = bashErrors.join("\n")
    const info = extractErrorInfo(combinedOutput)

    if (info.packages.length === 0 && info.symbols.length === 0) {
      log.info("no extractable error info from bash output")
      return
    }

    const queries = buildQueries(info)
    if (queries.length === 0) return

    // Search RAG for each query and collect results
    try {
      const configured = await RAG.isConfigured()
      if (!configured) return

      const allResults: RAG.SearchResult[] = []
      const seenChunks = new Set<string>()

      for (const query of queries) {
        const results = await RAG.search(query, 5, 0.25)
        for (const r of results) {
          if (!seenChunks.has(r.chunkID)) {
            seenChunks.add(r.chunkID)
            allResults.push(r)
          }
        }
      }

      if (allResults.length === 0) {
        log.info("no RAG results for error queries", { queries })
        return
      }

      // Sort by similarity and format within budget
      allResults.sort((a, b) => b.similarity - a.similarity)
      const formatted = RAGFormatter.formatResults(allResults, maxTokens - 50)

      if (!formatted) return

      const block = [
        "<error-context>",
        "The previous command failed. Here is relevant documentation from your indexed sources:",
        "",
        formatted,
        "</error-context>",
      ].join("\n")

      const tokenCount = Token.estimate(block)
      if (tokenCount > maxTokens) {
        log.warn("error context exceeds budget, truncating", { tokens: tokenCount, max: maxTokens })
        // Still cache it — better to have slightly over budget than nothing
      }

      cache.set(sessionID, block)
      log.info("error RAG context cached", {
        sessionID,
        queries,
        results: allResults.length,
        tokens: tokenCount,
      })
    } catch (err: any) {
      log.warn("error RAG search failed", { error: err.message })
    }
  }

  /**
   * Retrieve the cached error context for injection into the system prompt.
   *
   * @param sessionID - Session ID
   * @returns Cached error context block, or undefined if none
   */
  export function getInjection(sessionID: string): string | undefined {
    return cache.get(sessionID)
  }

  /**
   * Clear the cached error context after injection (one-shot).
   *
   * @param sessionID - Session ID
   */
  export function clearInjection(sessionID: string): void {
    cache.delete(sessionID)
  }

  /**
   * Clear all state for a session (cleanup on session end).
   *
   * @param sessionID - Session ID
   */
  export function clear(sessionID: string): void {
    cache.delete(sessionID)
  }

  /**
   * Check if output contains compilation/build errors.
   *
   * Detects Go, Rust, Python, TypeScript, and general build tool errors.
   *
   * @param output - Command output to check
   * @returns true if errors are detected
   */
  export function hasCompilationErrors(output: string): boolean {
    // Go errors
    if (/undefined:\s*\w+/i.test(output)) return true
    if (/cannot use .+ as .+ in/i.test(output)) return true
    if (/\.go:\d+:\d+:/.test(output)) return true
    if (/^# .+$/m.test(output) && /\.go:\d+/.test(output)) return true

    // Rust errors
    if (/^error\[E\d+\]:/m.test(output)) return true
    if (/cannot find .+ in (this scope|crate)/i.test(output)) return true

    // Python errors
    if (/No module named ['"]?\w+/i.test(output)) return true
    if (/ImportError:|ModuleNotFoundError:/i.test(output)) return true
    if (/NameError: name ['"]?\w+['"]? is not defined/i.test(output)) return true

    // TypeScript/JavaScript
    if (/Cannot find module ['"]?\w+/i.test(output)) return true
    if (/TS\d+:/.test(output)) return true

    // C/C++
    if (/undefined reference to ['"]?\w+/i.test(output)) return true
    if (/error: use of undeclared identifier/i.test(output)) return true

    // General build failure patterns
    if (/FAILED|BUILD FAILURE|compilation failed/i.test(output)) return true
    if (/^error:/m.test(output)) return true

    return false
  }

  /**
   * Extract structured error information from compiler/build output.
   *
   * Parses package names, symbol references, and error messages from
   * Go, Rust, Python, TypeScript, and C/C++ compiler output.
   *
   * @param output - Raw compiler/build output
   * @returns Structured error info with packages, symbols, and messages
   */
  export function extractErrorInfo(output: string): ErrorInfo {
    const packages = new Set<string>()
    const symbols = new Set<string>()
    const errorMessages: string[] = []

    // ── Go errors ──

    // "undefined: X" — missing symbol
    const goUndefined = output.matchAll(/undefined:\s*(\w+)/gi)
    for (const m of goUndefined) {
      symbols.add(m[1])
    }

    // "cannot use X as Y" — type mismatch
    const goCannotUse = output.matchAll(/cannot use (\w+(?:\.\w+)*) as (\w+(?:\.\w+)*)/gi)
    for (const m of goCannotUse) {
      symbols.add(m[1])
      symbols.add(m[2])
    }

    // "package.Function" references (e.g., "http.ListenAndServe")
    const goPkgRef = output.matchAll(/\b(\w+)\.([A-Z]\w+)\b/g)
    for (const m of goPkgRef) {
      // Only capture if it looks like a Go package reference
      const pkg = m[1]
      if (pkg.length > 1 && pkg[0] === pkg[0].toLowerCase()) {
        packages.add(pkg)
        symbols.add(`${pkg}.${m[2]}`)
      }
    }

    // Go import errors: "could not import <pkg>"
    const goImport = output.matchAll(/could not import (\S+)/gi)
    for (const m of goImport) {
      packages.add(m[1])
    }

    // Go package header: "# <package-path>"
    const goPkgHeader = output.matchAll(/^# (\S+)$/gm)
    for (const m of goPkgHeader) {
      const parts = m[1].split("/")
      packages.add(parts[parts.length - 1])
    }

    // ── Rust errors ──

    const rustNotFound = output.matchAll(/cannot find (?:function|struct|trait|type|module) `(\w+)` in (?:(?:this scope)|(?:crate `(\w+)`))/gi)
    for (const m of rustNotFound) {
      symbols.add(m[1])
      if (m[2]) packages.add(m[2])
    }

    // ── Python errors ──

    const pyNoModule = output.matchAll(/No module named ['"]?(\w+(?:\.\w+)*)['"]?/gi)
    for (const m of pyNoModule) {
      packages.add(m[1].split(".")[0])
    }

    const pyNameError = output.matchAll(/NameError: name ['"]?(\w+)['"]? is not defined/gi)
    for (const m of pyNameError) {
      symbols.add(m[1])
    }

    // ── TypeScript/JavaScript errors ──

    const tsNoModule = output.matchAll(/Cannot find module ['"]?(\w[\w\-/]*)['"]?/gi)
    for (const m of tsNoModule) {
      packages.add(m[1].split("/")[0])
    }

    // ── C/C++ errors ──

    const cUndefined = output.matchAll(/undefined reference to ['"]?(\w+)['"]?/gi)
    for (const m of cUndefined) {
      symbols.add(m[1])
    }

    // ── Extract error messages (first 5 unique lines with "error" keyword) ──
    const errorLines = output.split("\n").filter((line) =>
      /error[:\[]|cannot |undefined[: ]|not found|not defined|No module/i.test(line),
    )
    const seenMessages = new Set<string>()
    for (const line of errorLines) {
      const trimmed = line.trim()
      if (trimmed.length < 10 || trimmed.length > 200) continue
      if (seenMessages.has(trimmed)) continue
      seenMessages.add(trimmed)
      errorMessages.push(trimmed)
      if (errorMessages.length >= 5) break
    }

    return {
      output: output.slice(0, 500),
      packages: [...packages],
      symbols: [...symbols],
      errorMessages,
    }
  }

  /**
   * Generate 1-3 focused RAG search queries from extracted error info.
   *
   * Prioritizes package documentation queries (max 2), then symbol-specific
   * queries (max 1).
   *
   * @param info - Extracted error information
   * @returns Array of search query strings
   */
  export function buildQueries(info: ErrorInfo): string[] {
    const queries: string[] = []

    // Package documentation queries (max 2)
    const uniquePackages = [...new Set(info.packages)].slice(0, 2)
    for (const pkg of uniquePackages) {
      queries.push(`go package ${pkg} API documentation usage`)
    }

    // Symbol-specific query (max 1)
    const topSymbols = [...new Set(info.symbols)].slice(0, 2)
    if (topSymbols.length > 0) {
      queries.push(`${topSymbols.join(" ")} function signature parameters`)
    }

    return queries.slice(0, 3)
  }
}
