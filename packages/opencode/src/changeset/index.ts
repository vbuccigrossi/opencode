import { Log } from "@/util/log"
import fs from "fs"
import path from "path"

/**
 * Atomic change sets — accumulate multi-file edits as a coherent unit
 * that can be previewed, applied atomically, or rolled back.
 *
 * Different from staging (per-file) — a changeset is a named group
 * of edits across multiple files that succeed or fail as a unit.
 */
export namespace Changeset {
  const log = Log.create({ service: "changeset" })

  /** Status of a change set. */
  export type Status = "building" | "applied" | "rolled_back" | "discarded"

  /** A single file edit within a change set. */
  export interface FileEdit {
    /** Absolute file path. */
    filePath: string
    /** Original content (before edit). Empty string for new files. */
    original: string
    /** Proposed content (after edit). */
    proposed: string
    /** Whether this is a new file (no original content). */
    isNew: boolean
  }

  /** A complete change set. */
  export interface ChangesetInfo {
    /** Unique name for this change set. */
    name: string
    /** Human-readable description. */
    description?: string
    /** Current status. */
    status: Status
    /** File edits in this change set. */
    edits: FileEdit[]
    /** When the change set was created. */
    createdAt: number
    /** When the change set was last modified. */
    updatedAt: number
  }

  /** Diff hunk for preview. */
  export interface DiffHunk {
    filePath: string
    isNew: boolean
    added: number
    removed: number
    diff: string
  }

  /** Active change sets keyed by name. */
  const changesets = new Map<string, ChangesetInfo>()

  /**
   * Create a new change set.
   *
   * @param name - Unique name for the change set
   * @param description - Optional description
   * @returns The created change set
   */
  export function create(name: string, description?: string): ChangesetInfo {
    if (changesets.has(name)) {
      throw new Error(`Change set "${name}" already exists`)
    }

    const cs: ChangesetInfo = {
      name,
      description,
      status: "building",
      edits: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    changesets.set(name, cs)
    log.info("changeset created", { name })
    return cs
  }

  /**
   * Add a file edit to a change set.
   *
   * If the file already has an edit, it replaces the proposed content.
   * Reads the original content from disk if not provided.
   *
   * @param name - Change set name
   * @param filePath - Absolute file path
   * @param proposed - The new content for this file
   * @param original - Optional explicit original content (reads from disk if not provided)
   * @returns The updated change set
   */
  export function addEdit(
    name: string,
    filePath: string,
    proposed: string,
    original?: string,
  ): ChangesetInfo {
    const cs = getOrThrow(name)
    if (cs.status !== "building") {
      throw new Error(`Cannot add edits to change set "${name}" — status is ${cs.status}`)
    }

    const absPath = path.resolve(filePath)

    // Read original from disk if not provided
    let origContent: string
    let isNew = false
    if (original !== undefined) {
      origContent = original
    } else {
      try {
        origContent = fs.readFileSync(absPath, "utf-8")
      } catch {
        origContent = ""
        isNew = true
      }
    }

    // Replace existing edit for this file or add new
    const existingIdx = cs.edits.findIndex((e) => e.filePath === absPath)
    const edit: FileEdit = { filePath: absPath, original: origContent, proposed, isNew }

    if (existingIdx >= 0) {
      cs.edits[existingIdx] = edit
    } else {
      cs.edits.push(edit)
    }

    cs.updatedAt = Date.now()
    log.info("edit added to changeset", { name, filePath: absPath, isNew })
    return cs
  }

  /**
   * Remove a file from a change set.
   *
   * @param name - Change set name
   * @param filePath - File path to remove
   * @returns The updated change set
   */
  export function removeEdit(name: string, filePath: string): ChangesetInfo {
    const cs = getOrThrow(name)
    if (cs.status !== "building") {
      throw new Error(`Cannot modify change set "${name}" — status is ${cs.status}`)
    }

    const absPath = path.resolve(filePath)
    cs.edits = cs.edits.filter((e) => e.filePath !== absPath)
    cs.updatedAt = Date.now()
    return cs
  }

  /**
   * Preview all changes as a unified multi-file diff.
   *
   * @param name - Change set name
   * @returns Array of diff hunks, one per file
   */
  export function preview(name: string): DiffHunk[] {
    const cs = getOrThrow(name)
    return cs.edits.map((edit) => buildDiffHunk(edit))
  }

  /**
   * Format the preview as a human-readable string.
   *
   * @param name - Change set name
   * @returns Formatted diff string
   */
  export function formatPreview(name: string): string {
    const hunks = preview(name)
    if (hunks.length === 0) return "No changes in this change set."

    const cs = getOrThrow(name)
    const header = [`Change set: ${cs.name}${cs.description ? ` — ${cs.description}` : ""}`, `Files: ${hunks.length}`, ""]

    const totalAdded = hunks.reduce((sum, h) => sum + h.added, 0)
    const totalRemoved = hunks.reduce((sum, h) => sum + h.removed, 0)
    header.push(`Total: +${totalAdded} -${totalRemoved}`)
    header.push("")

    const fileDiffs = hunks.map((h) => {
      const label = h.isNew ? " (new file)" : ""
      return `--- ${h.filePath}${label}\n+++ ${h.filePath}\n${h.diff}`
    })

    return [...header, ...fileDiffs].join("\n")
  }

  /**
   * Apply all edits atomically — writes all files or rolls back on failure.
   *
   * @param name - Change set name
   * @returns List of files that were written
   */
  export function apply(name: string): string[] {
    const cs = getOrThrow(name)
    if (cs.status !== "building") {
      throw new Error(`Cannot apply change set "${name}" — status is ${cs.status}`)
    }
    if (cs.edits.length === 0) {
      throw new Error(`Change set "${name}" has no edits to apply`)
    }

    const written: string[] = []

    try {
      for (const edit of cs.edits) {
        // Ensure parent directory exists for new files
        if (edit.isNew) {
          const dir = path.dirname(edit.filePath)
          fs.mkdirSync(dir, { recursive: true })
        }

        fs.writeFileSync(edit.filePath, edit.proposed, "utf-8")
        written.push(edit.filePath)
      }

      cs.status = "applied"
      cs.updatedAt = Date.now()
      log.info("changeset applied", { name, files: written.length })
      return written
    } catch (err: any) {
      // Rollback: restore all already-written files to their originals
      log.warn("changeset apply failed, rolling back", { name, error: err.message, written: written.length })
      for (const filePath of written) {
        const edit = cs.edits.find((e) => e.filePath === filePath)
        if (edit) {
          try {
            if (edit.isNew) {
              // Remove newly created file
              fs.unlinkSync(filePath)
            } else {
              fs.writeFileSync(filePath, edit.original, "utf-8")
            }
          } catch (rollbackErr: any) {
            log.error("changeset rollback failed for file", { filePath, error: rollbackErr.message })
          }
        }
      }

      cs.status = "building" // Allow retry
      throw new Error(`Failed to apply change set "${name}": ${err.message}. All changes have been rolled back.`)
    }
  }

  /**
   * Rollback an applied change set — restores all files to their original content.
   *
   * @param name - Change set name
   * @returns List of files that were restored
   */
  export function rollback(name: string): string[] {
    const cs = getOrThrow(name)
    if (cs.status !== "applied") {
      throw new Error(`Cannot rollback change set "${name}" — status is ${cs.status} (must be "applied")`)
    }

    const restored: string[] = []
    for (const edit of cs.edits) {
      try {
        if (edit.isNew) {
          fs.unlinkSync(edit.filePath)
        } else {
          fs.writeFileSync(edit.filePath, edit.original, "utf-8")
        }
        restored.push(edit.filePath)
      } catch (err: any) {
        log.warn("changeset rollback failed for file", { name, filePath: edit.filePath, error: err.message })
      }
    }

    cs.status = "rolled_back"
    cs.updatedAt = Date.now()
    log.info("changeset rolled back", { name, files: restored.length })
    return restored
  }

  /**
   * Discard a change set without applying.
   *
   * @param name - Change set name
   */
  export function discard(name: string): void {
    const cs = getOrThrow(name)
    cs.status = "discarded"
    cs.updatedAt = Date.now()
    changesets.delete(name)
    log.info("changeset discarded", { name })
  }

  /**
   * Get a change set by name.
   *
   * @param name - Change set name
   * @returns The change set, or undefined
   */
  export function get(name: string): ChangesetInfo | undefined {
    return changesets.get(name)
  }

  /**
   * List all active change sets.
   *
   * @returns Array of change set summaries
   */
  export function list(): Array<{ name: string; status: Status; fileCount: number; description?: string }> {
    return [...changesets.values()].map((cs) => ({
      name: cs.name,
      status: cs.status,
      fileCount: cs.edits.length,
      description: cs.description,
    }))
  }

  /**
   * Clear all change sets (used for cleanup/testing).
   */
  export function clear(): void {
    changesets.clear()
  }

  // ─── Internal ──────────────────────────────────────────────────

  function getOrThrow(name: string): ChangesetInfo {
    const cs = changesets.get(name)
    if (!cs) throw new Error(`Change set "${name}" not found`)
    return cs
  }

  /**
   * Build a diff hunk for a single file edit.
   * Uses a simple line-by-line diff (no external dependencies).
   */
  function buildDiffHunk(edit: FileEdit): DiffHunk {
    const origLines = edit.original.split("\n")
    const propLines = edit.proposed.split("\n")

    if (edit.isNew) {
      return {
        filePath: edit.filePath,
        isNew: true,
        added: propLines.length,
        removed: 0,
        diff: propLines.map((l) => `+${l}`).join("\n"),
      }
    }

    // Simple line diff: find added/removed lines
    const origSet = new Set(origLines)
    const propSet = new Set(propLines)

    let added = 0
    let removed = 0
    const diffLines: string[] = []

    // Use LCS-based approach for better diffs
    const { lcs, addedLines, removedLines } = simpleDiff(origLines, propLines)

    for (const line of removedLines) {
      diffLines.push(`-${line}`)
      removed++
    }
    for (const line of addedLines) {
      diffLines.push(`+${line}`)
      added++
    }

    return {
      filePath: edit.filePath,
      isNew: false,
      added,
      removed,
      diff: diffLines.join("\n"),
    }
  }

  /**
   * Simple diff between two line arrays.
   * Returns added and removed lines.
   */
  function simpleDiff(
    origLines: string[],
    propLines: string[],
  ): { lcs: number; addedLines: string[]; removedLines: string[] } {
    // Build a line-frequency map for quick comparison
    const origMap = new Map<string, number>()
    for (const line of origLines) {
      origMap.set(line, (origMap.get(line) ?? 0) + 1)
    }

    const propMap = new Map<string, number>()
    for (const line of propLines) {
      propMap.set(line, (propMap.get(line) ?? 0) + 1)
    }

    const removedLines: string[] = []
    const addedLines: string[] = []
    let lcs = 0

    // Lines removed (in orig but not in prop, or fewer occurrences)
    const countedOrig = new Map<string, number>()
    for (const line of origLines) {
      const count = (countedOrig.get(line) ?? 0) + 1
      countedOrig.set(line, count)
      if (count > (propMap.get(line) ?? 0)) {
        removedLines.push(line)
      } else {
        lcs++
      }
    }

    // Lines added (in prop but not in orig, or more occurrences)
    const countedProp = new Map<string, number>()
    for (const line of propLines) {
      const count = (countedProp.get(line) ?? 0) + 1
      countedProp.set(line, count)
      if (count > (origMap.get(line) ?? 0)) {
        addedLines.push(line)
      }
    }

    return { lcs, addedLines, removedLines }
  }
}
