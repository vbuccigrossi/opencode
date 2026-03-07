import { Token } from "@/util/token"
import { Log } from "@/util/log"
import { Graph } from "@/graph"
import { Instance } from "@/project/instance"
import type { Scorer } from "./scorer"
import fs from "fs"
import path from "path"

/**
 * Packs scored candidates into a token-budgeted context block.
 *
 * Instead of sending entire files, extracts the relevant entity bodies
 * (function definitions, class declarations, interface types) along with
 * structural annotations (callers, callees, test coverage).
 */
export namespace Packer {
  const log = Log.create({ service: "context.packer" })

  /** Options for context packing. */
  export interface PackOptions {
    /** Maximum tokens to use for context (default: 6000) */
    maxTokens: number
    /** Whether to include structural annotations (default: true) */
    annotations: boolean
    /** Whether to include signatures for entities that don't fit full body (default: true) */
    signatures: boolean
  }

  const DEFAULT_OPTIONS: PackOptions = {
    maxTokens: 6000,
    annotations: true,
    signatures: true,
  }

  /** A packed context entry ready for inclusion in the prompt. */
  export interface PackedEntry {
    /** File path relative to project root */
    filePath: string
    /** The code content (full body or signature) */
    content: string
    /** Whether this is a full body or just a signature */
    mode: "full" | "signature" | "file-header"
    /** Estimated token count */
    tokens: number
    /** Relevance score from the scorer */
    score: number
  }

  /** The final packed context block. */
  export interface PackedContext {
    /** Ordered entries included in the context */
    entries: PackedEntry[]
    /** Total tokens used */
    totalTokens: number
    /** Number of candidates that were scored but didn't fit */
    dropped: number
    /** Human-readable context block for the system prompt */
    text: string
  }

  /**
   * Packs scored candidates into a context block within the token budget.
   *
   * Strategy:
   * 1. For top-scoring entities, include full body (function/class definition)
   * 2. For medium-scoring entities, include just the signature
   * 3. Group by file for readability
   * 4. Add structural annotations (callers, callees) if enabled
   *
   * @param candidates - Scored candidates from the relevance pipeline
   * @param projectID - Project scope for graph queries
   * @param options - Packing configuration
   * @returns Packed context block
   */
  export function pack(
    candidates: Scorer.ScoredCandidate[],
    projectID: string,
    options: Partial<PackOptions> = {},
  ): PackedContext {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const entries: PackedEntry[] = []
    let totalTokens = 0
    let dropped = 0

    // Group candidates by file for more efficient extraction
    const byFile = new Map<string, Scorer.ScoredCandidate[]>()
    for (const c of candidates) {
      if (c.score <= 0) continue
      const list = byFile.get(c.filePath) ?? []
      list.push(c)
      byFile.set(c.filePath, list)
    }

    // Process candidates in score order
    for (const candidate of candidates) {
      if (candidate.score <= 0) continue
      if (totalTokens >= opts.maxTokens) {
        dropped++
        continue
      }

      const remaining = opts.maxTokens - totalTokens

      // Try to extract the full entity body
      if (candidate.startLine && candidate.endLine) {
        const body = extractLines(candidate.filePath, candidate.startLine, candidate.endLine)
        if (body) {
          const bodyTokens = Token.estimate(body)
          if (bodyTokens <= remaining && bodyTokens <= 500) {
            // Full body fits — include it
            let content = body
            if (opts.annotations) {
              content = addAnnotations(content, candidate, projectID)
            }
            const finalTokens = Token.estimate(content)
            if (finalTokens <= remaining) {
              entries.push({
                filePath: candidate.filePath,
                content,
                mode: "full",
                tokens: finalTokens,
                score: candidate.score,
              })
              totalTokens += finalTokens
              continue
            }
          }
        }
      }

      // Fall back to signature if body is too large or not available
      if (opts.signatures && candidate.signature) {
        const sig = `${candidate.kind} ${candidate.signature}`
        const sigTokens = Token.estimate(sig)
        if (sigTokens <= remaining) {
          entries.push({
            filePath: candidate.filePath,
            content: sig,
            mode: "signature",
            tokens: sigTokens,
            score: candidate.score,
          })
          totalTokens += sigTokens
          continue
        }
      }

      dropped++
    }

    // Build the text block
    const text = formatContextBlock(entries)

    return { entries, totalTokens, dropped, text }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Extracts lines from a file.
   *
   * @param filePath - Relative path from project root
   * @param startLine - 1-based start line
   * @param endLine - 1-based end line
   * @returns Extracted text, or undefined if file can't be read
   */
  function extractLines(filePath: string, startLine: number, endLine: number): string | undefined {
    try {
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(Instance.worktree, filePath)
      const content = fs.readFileSync(absPath, "utf-8")
      const lines = content.split("\n")
      const start = Math.max(0, startLine - 1)
      const end = Math.min(lines.length, endLine)
      return lines.slice(start, end).join("\n")
    } catch {
      return undefined
    }
  }

  /**
   * Adds structural annotations to a code snippet.
   * e.g., "// callers: handleRequest, processData"
   */
  function addAnnotations(content: string, candidate: Scorer.ScoredCandidate, projectID: string): string {
    if (!candidate.name) return content

    const annotations: string[] = []

    try {
      const callers = Graph.callersOf(projectID, candidate.name)
      if (callers.length > 0) {
        const callerNames = callers.slice(0, 5).map((c) => c.name)
        annotations.push(`// callers: ${callerNames.join(", ")}${callers.length > 5 ? ` (+${callers.length - 5} more)` : ""}`)
      }

      const callees = Graph.calleesOf(projectID, candidate.name)
      if (callees.length > 0) {
        const calleeNames = callees.slice(0, 5).map((c) => c.name)
        annotations.push(`// calls: ${calleeNames.join(", ")}${callees.length > 5 ? ` (+${callees.length - 5} more)` : ""}`)
      }
    } catch {
      // Graph queries may fail if not indexed — annotations are optional
    }

    if (annotations.length === 0) return content
    return annotations.join("\n") + "\n" + content
  }

  /**
   * Formats the packed entries into a readable context block for the system prompt.
   */
  function formatContextBlock(entries: PackedEntry[]): string {
    if (entries.length === 0) return ""

    // Group entries by file
    const byFile = new Map<string, PackedEntry[]>()
    for (const entry of entries) {
      const list = byFile.get(entry.filePath) ?? []
      list.push(entry)
      byFile.set(entry.filePath, list)
    }

    const sections: string[] = []

    for (const [filePath, fileEntries] of byFile) {
      const fullBodies = fileEntries.filter((e) => e.mode === "full")
      const signatures = fileEntries.filter((e) => e.mode === "signature")

      const parts: string[] = [`// ${filePath}`]

      for (const entry of fullBodies) {
        parts.push(entry.content)
      }

      if (signatures.length > 0) {
        for (const sig of signatures) {
          parts.push(sig.content)
        }
      }

      sections.push(parts.join("\n"))
    }

    return [
      "<codebase-context>",
      "The following code entities are relevant to the current task:",
      "",
      ...sections.map((s) => s + "\n"),
      "</codebase-context>",
    ].join("\n")
  }
}
