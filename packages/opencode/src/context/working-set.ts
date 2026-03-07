import { Log } from "@/util/log"
import { Token } from "@/util/token"
import fs from "fs/promises"
import path from "path"

/**
 * Working set — tracks files the agent is actively working with,
 * scored by relevance and subject to temporal decay.
 *
 * The working set evolves based on tool results (edits, reads, errors)
 * and graph relationships. Files that haven't been accessed recently
 * decay and eventually drop out, keeping context focused.
 */
export namespace WorkingSet {
  const log = Log.create({ service: "context.working-set" })

  /** A file tracked in the working set. */
  export interface Entry {
    /** Relative file path */
    filePath: string
    /** Current relevance score (0-1) */
    relevance: number
    /** Step number when last accessed */
    lastAccessed: number
    /** Why this file is in the working set */
    reason: string
    /** Whether the file has been edited (not just read) */
    edited: boolean
  }

  /** A snapshot of the working set for injection. */
  export interface Snapshot {
    entries: Entry[]
    totalTokens: number
  }

  /** Decay multiplier applied each step. */
  const DECAY_RATE = 0.85

  /** Steps after which an unaccessed file is evicted. */
  const EVICTION_THRESHOLD = 6

  /** Minimum relevance to remain in the set. */
  const MIN_RELEVANCE = 0.1

  /** Maximum files in the working set. */
  const MAX_FILES = 30

  /** Maximum lines to extract for file summary. */
  const SUMMARY_LINES = 25

  /**
   * Creates a new empty working set state.
   *
   * @returns Fresh state with no files and step 0
   */
  export function create(): State {
    return {
      files: new Map(),
      currentStep: 0,
    }
  }

  /** Internal mutable state. */
  export interface State {
    files: Map<string, Entry>
    currentStep: number
  }

  /**
   * Advances to the next step, applying decay to all entries
   * and evicting stale files.
   *
   * @param state - Working set state
   * @returns Updated state (mutated in place)
   */
  export function advanceStep(state: State): State {
    state.currentStep++

    const toEvict: string[] = []
    for (const [filePath, entry] of state.files) {
      // Apply decay
      entry.relevance *= DECAY_RATE

      // Evict if below threshold or too old
      const stepsIdle = state.currentStep - entry.lastAccessed
      if (entry.relevance < MIN_RELEVANCE || stepsIdle >= EVICTION_THRESHOLD) {
        toEvict.push(filePath)
      }
    }

    for (const fp of toEvict) {
      state.files.delete(fp)
    }

    return state
  }

  /**
   * Adds or updates a file in the working set.
   *
   * @param state - Working set state
   * @param filePath - Relative file path
   * @param relevance - Relevance score (0-1)
   * @param reason - Why the file is being added
   * @param edited - Whether the file was edited
   * @returns Updated state
   */
  export function touch(
    state: State,
    filePath: string,
    relevance: number,
    reason: string,
    edited = false,
  ): State {
    const existing = state.files.get(filePath)
    if (existing) {
      // Boost relevance, don't reduce it
      existing.relevance = Math.max(existing.relevance, Math.min(1, relevance))
      existing.lastAccessed = state.currentStep
      if (reason) existing.reason = reason
      if (edited) existing.edited = true
    } else {
      // Enforce max files — evict lowest relevance if needed
      if (state.files.size >= MAX_FILES) {
        let lowestKey: string | undefined
        let lowestScore = Infinity
        for (const [key, entry] of state.files) {
          if (entry.relevance < lowestScore) {
            lowestScore = entry.relevance
            lowestKey = key
          }
        }
        if (lowestKey) state.files.delete(lowestKey)
      }

      state.files.set(filePath, {
        filePath,
        relevance: Math.min(1, relevance),
        lastAccessed: state.currentStep,
        reason,
        edited,
      })
    }

    return state
  }

  /**
   * Removes a file from the working set.
   *
   * @param state - Working set state
   * @param filePath - File to remove
   * @returns Updated state
   */
  export function remove(state: State, filePath: string): State {
    state.files.delete(filePath)
    return state
  }

  /**
   * Gets the top entries sorted by relevance, within a token budget.
   *
   * @param state - Working set state
   * @param maxTokens - Maximum tokens for the context block
   * @returns Snapshot of selected entries and token usage
   */
  export function select(state: State, maxTokens: number): Snapshot {
    const sorted = [...state.files.values()].sort((a, b) => b.relevance - a.relevance)

    const selected: Entry[] = []
    let totalTokens = 0

    for (const entry of sorted) {
      // Estimate ~30 tokens per file entry (path + summary line)
      const estimate = 30
      if (totalTokens + estimate > maxTokens) break
      selected.push(entry)
      totalTokens += estimate
    }

    return { entries: selected, totalTokens }
  }

  /**
   * Gets all current entries (unfiltered).
   *
   * @param state - Working set state
   * @returns Array of all entries
   */
  export function all(state: State): Entry[] {
    return [...state.files.values()]
  }

  /**
   * Syncs the working set with the session state's workingSet array.
   * Files in the session state that aren't in the working set get added.
   * This allows the agent's manual file management to feed into dynamic context.
   *
   * @param state - Working set state
   * @param sessionFiles - Files from SessionState.workingSet
   * @returns Updated state
   */
  export function syncFromSessionState(state: State, sessionFiles: string[]): State {
    for (const fp of sessionFiles) {
      if (!state.files.has(fp)) {
        touch(state, fp, 0.5, "from session state")
      }
    }
    return state
  }

  /**
   * Formats the working set as a compact context block for injection.
   *
   * @param entries - Selected entries to format
   * @returns Formatted `<working-context>` XML block, or empty string
   */
  export function format(entries: Entry[]): string {
    if (entries.length === 0) return ""

    const lines: string[] = []
    for (const entry of entries) {
      const tag = entry.edited ? "edited" : "read"
      const score = entry.relevance.toFixed(2)
      lines.push(`- [${tag}] ${entry.filePath} (${entry.reason}, relevance: ${score})`)
    }

    return `<working-context>\n${lines.join("\n")}\n</working-context>`
  }
}
