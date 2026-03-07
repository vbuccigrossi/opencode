import { Log } from "../util/log"
import fs from "fs/promises"
import path from "path"

/**
 * Merge conflict parser and resolution system.
 *
 * Parses conflict markers into structured data, suggests resolutions,
 * and applies them cleanly.
 */
export namespace Conflicts {
  const log = Log.create({ service: "git.conflicts" })

  /** A parsed conflict hunk. */
  export interface ConflictHunk {
    /** 1-based start line of the conflict marker. */
    startLine: number
    /** 1-based end line (the >>>>>>> marker). */
    endLine: number
    /** Content from the current branch (ours). */
    ours: string
    /** Content from the incoming branch (theirs). */
    theirs: string
    /** Common ancestor content (if 3-way merge). */
    base?: string
    /** Lines before the conflict for context. */
    contextBefore: string[]
    /** Lines after the conflict for context. */
    contextAfter: string[]
  }

  /** Resolution strategy. */
  export type Strategy = "ours" | "theirs" | "both" | "custom"

  /** A resolution for a conflict hunk. */
  export interface Resolution {
    hunkIndex: number
    strategy: Strategy
    /** Custom content (required for strategy "custom"). */
    content?: string
  }

  /**
   * Parse conflict markers from file content.
   *
   * @param content - File content with conflict markers
   * @returns Parsed conflict hunks
   */
  export function parse(content: string): ConflictHunk[] {
    const lines = content.split("\n")
    const hunks: ConflictHunk[] = []
    let i = 0

    while (i < lines.length) {
      if (lines[i].startsWith("<<<<<<<")) {
        const startLine = i + 1
        const oursLines: string[] = []
        const baseLines: string[] = []
        const theirsLines: string[] = []
        let section: "ours" | "base" | "theirs" = "ours"
        let hasBase = false
        i++

        while (i < lines.length) {
          if (lines[i].startsWith("|||||||")) {
            section = "base"
            hasBase = true
            i++
            continue
          }
          if (lines[i].startsWith("=======")) {
            section = "theirs"
            i++
            continue
          }
          if (lines[i].startsWith(">>>>>>>")) {
            const endLine = i + 1
            const contextBefore = lines.slice(Math.max(0, startLine - 4), startLine - 1)
            const contextAfter = lines.slice(endLine, Math.min(lines.length, endLine + 3))

            hunks.push({
              startLine,
              endLine,
              ours: oursLines.join("\n"),
              theirs: theirsLines.join("\n"),
              base: hasBase ? baseLines.join("\n") : undefined,
              contextBefore,
              contextAfter,
            })
            i++
            break
          }

          if (section === "ours") oursLines.push(lines[i])
          else if (section === "base") baseLines.push(lines[i])
          else theirsLines.push(lines[i])
          i++
        }
      } else {
        i++
      }
    }

    return hunks
  }

  /**
   * Parse conflicts from a file on disk.
   *
   * @param filePath - Path to the conflicted file
   * @returns Parsed conflict hunks
   */
  export async function parseFile(filePath: string): Promise<ConflictHunk[]> {
    const content = await fs.readFile(filePath, "utf-8")
    return parse(content)
  }

  /**
   * Resolve a specific conflict hunk in file content.
   *
   * @param content - File content with conflict markers
   * @param hunkIndex - 0-based index of the hunk to resolve
   * @param strategy - Resolution strategy
   * @param customContent - Custom content (for "custom" strategy)
   * @returns Updated file content
   */
  export function resolve(content: string, hunkIndex: number, strategy: Strategy, customContent?: string): string {
    const lines = content.split("\n")
    const hunks = parse(content)

    if (hunkIndex < 0 || hunkIndex >= hunks.length) {
      throw new Error(`Invalid hunk index ${hunkIndex}. File has ${hunks.length} conflict(s).`)
    }

    const hunk = hunks[hunkIndex]
    const replacement = getResolution(hunk, strategy, customContent)
    const replacementLines = replacement.split("\n")

    // Replace from startLine-1 to endLine-1 (0-based)
    const before = lines.slice(0, hunk.startLine - 1)
    const after = lines.slice(hunk.endLine)

    return [...before, ...replacementLines, ...after].join("\n")
  }

  /**
   * Resolve all conflicts in file content with a single strategy.
   *
   * @param content - File content with conflict markers
   * @param strategy - Resolution strategy for all hunks
   * @returns Updated file content with no conflict markers
   */
  export function resolveAll(content: string, strategy: Strategy): string {
    const hunks = parse(content)
    // Resolve in reverse order to preserve line numbers
    let result = content
    for (let i = hunks.length - 1; i >= 0; i--) {
      result = resolve(result, i, strategy)
    }
    return result
  }

  /**
   * Apply multiple resolutions to file content.
   *
   * @param content - File content with conflict markers
   * @param resolutions - Array of resolutions (applied in reverse hunk order)
   * @returns Updated file content
   */
  export function applyResolutions(content: string, resolutions: Resolution[]): string {
    // Sort by hunk index descending to preserve line numbers
    const sorted = [...resolutions].sort((a, b) => b.hunkIndex - a.hunkIndex)
    let result = content
    for (const r of sorted) {
      result = resolve(result, r.hunkIndex, r.strategy, r.content)
    }
    return result
  }

  /**
   * Resolve a file on disk.
   *
   * @param filePath - Path to the conflicted file
   * @param resolutions - Resolutions to apply
   */
  export async function resolveFile(filePath: string, resolutions: Resolution[]): Promise<void> {
    const content = await fs.readFile(filePath, "utf-8")
    const resolved = applyResolutions(content, resolutions)
    await fs.writeFile(filePath, resolved, "utf-8")
    log.info("resolved", { file: filePath, hunks: resolutions.length })
  }

  /**
   * Suggest a resolution for a conflict hunk.
   *
   * Simple heuristic: if one side is empty, pick the other.
   * If one side is a superset, pick the superset.
   *
   * @param hunk - The conflict hunk
   * @returns Suggested strategy and confidence
   */
  export function suggest(hunk: ConflictHunk): { strategy: Strategy; confidence: number; reason: string } {
    // If one side is empty, pick the other
    if (hunk.ours.trim() === "" && hunk.theirs.trim() !== "") {
      return { strategy: "theirs", confidence: 0.9, reason: "Our side is empty (deletion vs addition)" }
    }
    if (hunk.theirs.trim() === "" && hunk.ours.trim() !== "") {
      return { strategy: "ours", confidence: 0.9, reason: "Their side is empty (deletion vs addition)" }
    }

    // If one side is a superset of the other
    if (hunk.theirs.includes(hunk.ours)) {
      return { strategy: "theirs", confidence: 0.7, reason: "Their version contains all of our changes" }
    }
    if (hunk.ours.includes(hunk.theirs)) {
      return { strategy: "ours", confidence: 0.7, reason: "Our version contains all of their changes" }
    }

    // If base exists and one side matches base (unchanged), pick the other
    if (hunk.base !== undefined) {
      if (hunk.ours === hunk.base) {
        return { strategy: "theirs", confidence: 0.85, reason: "Our side unchanged from base; their side has changes" }
      }
      if (hunk.theirs === hunk.base) {
        return { strategy: "ours", confidence: 0.85, reason: "Their side unchanged from base; our side has changes" }
      }
    }

    // Both sides have meaningful, non-overlapping changes
    return { strategy: "both", confidence: 0.3, reason: "Both sides have distinct changes; manual review recommended" }
  }

  function getResolution(hunk: ConflictHunk, strategy: Strategy, customContent?: string): string {
    switch (strategy) {
      case "ours":
        return hunk.ours
      case "theirs":
        return hunk.theirs
      case "both":
        return hunk.ours + "\n" + hunk.theirs
      case "custom":
        if (customContent === undefined) throw new Error("Custom content required for 'custom' strategy")
        return customContent
    }
  }

  /** Format a conflict hunk for display. */
  export function formatHunk(hunk: ConflictHunk, index: number): string {
    const lines: string[] = [
      `Conflict #${index + 1} (lines ${hunk.startLine}-${hunk.endLine}):`,
      "",
      "--- OURS ---",
      hunk.ours || "(empty)",
      "",
      "--- THEIRS ---",
      hunk.theirs || "(empty)",
    ]
    if (hunk.base !== undefined) {
      lines.push("", "--- BASE ---", hunk.base || "(empty)")
    }
    const suggestion = suggest(hunk)
    lines.push("", `Suggestion: ${suggestion.strategy} (${Math.round(suggestion.confidence * 100)}% confidence)`, `  ${suggestion.reason}`)
    return lines.join("\n")
  }

  /** Format all conflicts in a file. */
  export function format(hunks: ConflictHunk[]): string {
    if (hunks.length === 0) return "No conflicts found."
    return [`${hunks.length} conflict(s):`, "", ...hunks.map((h, i) => formatHunk(h, i))].join("\n")
  }
}
