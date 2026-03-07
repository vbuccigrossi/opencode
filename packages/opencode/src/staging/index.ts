import { Log } from "@/util/log"
import { readFile, writeFile } from "fs/promises"

/**
 * Edit staging & preview — holds pending edits in memory so the
 * agent can review a full changeset before committing to disk.
 *
 * Flow: stage → review diff → apply (or discard).
 */
export namespace Staging {
  const log = Log.create({ service: "staging" })

  /** A single staged edit. */
  export interface StagedEdit {
    /** Target file path. */
    filePath: string
    /** Original file content (snapshot at stage time). */
    original: string
    /** Proposed new content. */
    proposed: string
    /** Human-readable description. */
    description: string
    /** Timestamp when staged. */
    timestamp: number
  }

  /** A staging area (like a named changeset). */
  export interface StagingArea {
    id: string
    description: string
    edits: StagedEdit[]
    status: "open" | "applied" | "discarded"
    createdAt: number
  }

  /** All staging areas, keyed by ID. */
  const areas = new Map<string, StagingArea>()
  let counter = 0

  /**
   * Create a new staging area.
   *
   * @param description - Description of the changeset
   * @returns The new staging area
   */
  export function create(description: string): StagingArea {
    const id = `stage-${++counter}`
    const area: StagingArea = {
      id,
      description,
      edits: [],
      status: "open",
      createdAt: Date.now(),
    }
    areas.set(id, area)
    log.info("staging area created", { id, description })
    return area
  }

  /**
   * Stage a file edit. Reads the current file content as the original.
   *
   * @param areaId - Staging area ID
   * @param filePath - Target file path
   * @param proposed - Proposed new content
   * @param description - Description of this edit
   */
  export async function stage(
    areaId: string,
    filePath: string,
    proposed: string,
    description: string,
  ): Promise<StagedEdit> {
    const area = areas.get(areaId)
    if (!area) throw new Error(`Staging area not found: ${areaId}`)
    if (area.status !== "open") throw new Error(`Staging area ${areaId} is ${area.status}`)

    let original = ""
    try {
      original = await readFile(filePath, "utf-8")
    } catch {
      // New file — original is empty
    }

    const edit: StagedEdit = {
      filePath,
      original,
      proposed,
      description,
      timestamp: Date.now(),
    }

    // Replace existing edit for same file
    const idx = area.edits.findIndex((e) => e.filePath === filePath)
    if (idx >= 0) {
      area.edits[idx] = edit
    } else {
      area.edits.push(edit)
    }

    return edit
  }

  /**
   * Stage a file edit with explicit original content (no disk read).
   *
   * @param areaId - Staging area ID
   * @param filePath - Target file path
   * @param original - Original file content
   * @param proposed - Proposed new content
   * @param description - Description of this edit
   */
  export function stageWithOriginal(
    areaId: string,
    filePath: string,
    original: string,
    proposed: string,
    description: string,
  ): StagedEdit {
    const area = areas.get(areaId)
    if (!area) throw new Error(`Staging area not found: ${areaId}`)
    if (area.status !== "open") throw new Error(`Staging area ${areaId} is ${area.status}`)

    const edit: StagedEdit = {
      filePath,
      original,
      proposed,
      description,
      timestamp: Date.now(),
    }

    const idx = area.edits.findIndex((e) => e.filePath === filePath)
    if (idx >= 0) {
      area.edits[idx] = edit
    } else {
      area.edits.push(edit)
    }

    return edit
  }

  /**
   * Get a staging area by ID.
   *
   * @param areaId - Staging area ID
   * @returns The staging area, or undefined
   */
  export function get(areaId: string): StagingArea | undefined {
    return areas.get(areaId)
  }

  /**
   * List all staging areas.
   *
   * @returns All staging areas
   */
  export function list(): StagingArea[] {
    return [...areas.values()]
  }

  /**
   * Generate a unified diff preview of all staged edits.
   *
   * @param areaId - Staging area ID
   * @returns Unified diff string
   */
  export function diff(areaId: string): string {
    const area = areas.get(areaId)
    if (!area) throw new Error(`Staging area not found: ${areaId}`)

    if (area.edits.length === 0) return "No staged edits."

    const parts: string[] = []

    for (const edit of area.edits) {
      parts.push(`--- a/${edit.filePath}`)
      parts.push(`+++ b/${edit.filePath}`)
      parts.push(`# ${edit.description}`)

      const origLines = edit.original.split("\n")
      const propLines = edit.proposed.split("\n")

      // Simple line-by-line diff
      const maxLines = Math.max(origLines.length, propLines.length)
      let changed = false

      for (let i = 0; i < maxLines; i++) {
        const orig = origLines[i]
        const prop = propLines[i]

        if (orig === prop) {
          if (changed) parts.push(` ${orig ?? ""}`)
        } else {
          changed = true
          if (orig !== undefined) parts.push(`-${orig}`)
          if (prop !== undefined) parts.push(`+${prop}`)
        }
      }

      parts.push("")
    }

    return parts.join("\n")
  }

  /**
   * Apply all staged edits to disk.
   *
   * @param areaId - Staging area ID
   * @returns Number of files written
   */
  export async function apply(areaId: string): Promise<number> {
    const area = areas.get(areaId)
    if (!area) throw new Error(`Staging area not found: ${areaId}`)
    if (area.status !== "open") throw new Error(`Staging area ${areaId} is ${area.status}`)

    let written = 0
    for (const edit of area.edits) {
      await writeFile(edit.filePath, edit.proposed, "utf-8")
      written++
    }

    area.status = "applied"
    log.info("staging area applied", { id: areaId, files: written })
    return written
  }

  /**
   * Discard all staged edits.
   *
   * @param areaId - Staging area ID
   */
  export function discard(areaId: string): void {
    const area = areas.get(areaId)
    if (!area) throw new Error(`Staging area not found: ${areaId}`)

    area.status = "discarded"
    log.info("staging area discarded", { id: areaId })
  }

  /**
   * Remove a single edit from a staging area.
   *
   * @param areaId - Staging area ID
   * @param filePath - File path to remove
   */
  export function unstage(areaId: string, filePath: string): void {
    const area = areas.get(areaId)
    if (!area) throw new Error(`Staging area not found: ${areaId}`)
    if (area.status !== "open") throw new Error(`Staging area ${areaId} is ${area.status}`)

    area.edits = area.edits.filter((e) => e.filePath !== filePath)
  }

  /**
   * Format a staging area summary.
   *
   * @param areaId - Staging area ID
   * @returns Human-readable summary
   */
  export function format(areaId: string): string {
    const area = areas.get(areaId)
    if (!area) return `Staging area not found: ${areaId}`

    const lines: string[] = []
    lines.push(`Staging area ${area.id} [${area.status}]: ${area.description}`)
    lines.push(`${area.edits.length} edit(s):`)

    for (const edit of area.edits) {
      const origLen = edit.original.split("\n").length
      const propLen = edit.proposed.split("\n").length
      const delta = propLen - origLen
      const sign = delta >= 0 ? "+" : ""
      lines.push(`  ${edit.filePath} (${sign}${delta} lines) — ${edit.description}`)
    }

    return lines.join("\n")
  }

  /**
   * Clear all staging areas.
   */
  export function clearAll(): void {
    areas.clear()
    counter = 0
  }
}
