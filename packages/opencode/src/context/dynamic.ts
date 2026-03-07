import { Log } from "@/util/log"
import { WorkingSet } from "./working-set"
import { Graph } from "@/graph"
import { Instance } from "@/project/instance"
import { SessionState } from "@/session/state"
import type { MessageV2 } from "@/session/message-v2"

/**
 * Dynamic context — makes context selection reactive by evolving
 * the working set based on what the agent is actually doing.
 *
 * Instead of a one-shot context pipeline at step 1, this module
 * continuously tracks tool results (edits, reads, errors) and
 * graph relationships to keep the context window focused on
 * currently relevant files.
 *
 * Integration:
 * - `processToolResults()` is called after each processor step
 *   to extract file references from tool results
 * - `getInjection()` is called at the start of each step (>1)
 *   to inject a compact working context block
 * - Syncs with SessionState.workingSet for agent-controlled files
 */
export namespace DynamicContext {
  const log = Log.create({ service: "context.dynamic" })

  /** Per-session state keyed by sessionID. */
  const sessions = new Map<string, WorkingSet.State>()

  /**
   * Gets or creates the working set state for a session.
   *
   * @param sessionID - Session identifier
   * @returns Working set state
   */
  export function getState(sessionID: string): WorkingSet.State {
    let state = sessions.get(sessionID)
    if (!state) {
      state = WorkingSet.create()
      sessions.set(sessionID, state)
    }
    return state
  }

  /**
   * Clears state for a session (e.g., on session end).
   *
   * @param sessionID - Session identifier
   */
  export function clear(sessionID: string): void {
    sessions.delete(sessionID)
  }

  /**
   * Processes tool results from a completed step to update the working set.
   *
   * Extracts file references from tool call inputs and outputs:
   * - read/edit/write tools → file_path input
   * - grep/glob tools → matched files from output
   * - verify errors → file paths from error locations
   *
   * Also expands via graph to find callers/callees of edited entities.
   *
   * @param sessionID - Session identifier
   * @param parts - Message parts from the completed step
   */
  export function processToolResults(
    sessionID: string,
    parts: MessageV2.ToolPart[],
  ): void {
    const state = getState(sessionID)

    for (const part of parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue

      const input = part.state.input as Record<string, unknown> | undefined
      if (!input) continue

      switch (part.tool) {
        case "read": {
          const filePath = input.file_path as string
          if (filePath) {
            WorkingSet.touch(state, normalizePath(filePath), 0.7, "read by agent")
            expandNeighbors(state, filePath, 0.3)
          }
          break
        }

        case "edit":
        case "write":
        case "apply_patch": {
          const filePath = input.file_path as string
          if (filePath) {
            WorkingSet.touch(state, normalizePath(filePath), 0.9, "edited by agent", true)
            expandNeighbors(state, filePath, 0.5)
          }
          break
        }

        case "grep": {
          // Extract file paths from grep output
          const output = part.state.output
          if (typeof output === "string") {
            const files = extractFilePathsFromOutput(output)
            for (const fp of files.slice(0, 5)) {
              WorkingSet.touch(state, normalizePath(fp), 0.4, "grep match")
            }
          }
          break
        }

        case "glob": {
          const output = part.state.output
          if (typeof output === "string") {
            const files = extractFilePathsFromOutput(output)
            for (const fp of files.slice(0, 5)) {
              WorkingSet.touch(state, normalizePath(fp), 0.3, "glob match")
            }
          }
          break
        }

        case "verify": {
          // Verification errors — high relevance
          const output = part.state.output
          if (typeof output === "string") {
            const files = extractFilePathsFromErrors(output)
            for (const fp of files.slice(0, 10)) {
              WorkingSet.touch(state, normalizePath(fp), 0.8, "verification error")
            }
          }
          break
        }

        case "state": {
          // If agent updates working set via state tool, sync
          const op = input.operation as string
          if (op === "update_working_set") {
            const addFiles = input.add_files as string[] | undefined
            if (addFiles) {
              for (const fp of addFiles) {
                WorkingSet.touch(state, normalizePath(fp), 0.6, "agent working set")
              }
            }
          }
          break
        }
      }
    }
  }

  /**
   * Produces a context injection block for the current step.
   *
   * Called on steps > 1 to provide evolving context. Advances the
   * step counter (applying decay), syncs with session state, and
   * selects top entries within the token budget.
   *
   * @param sessionID - Session identifier
   * @param messages - Current conversation messages (for session state sync)
   * @param maxTokens - Token budget for the working context block
   * @returns Formatted context block, or empty string
   */
  export function getInjection(
    sessionID: string,
    messages: MessageV2.WithParts[],
    maxTokens: number,
  ): string {
    const state = getState(sessionID)

    // Advance step (applies decay, evicts stale files)
    WorkingSet.advanceStep(state)

    // Sync with session state working set
    try {
      const sessionState = SessionState.extract(messages)
      if (sessionState && sessionState.workingSet.length > 0) {
        WorkingSet.syncFromSessionState(state, sessionState.workingSet)
      }
    } catch {
      // Non-critical — continue without sync
    }

    // Select top entries within budget
    const snapshot = WorkingSet.select(state, maxTokens)
    if (snapshot.entries.length === 0) return ""

    return WorkingSet.format(snapshot.entries)
  }

  /**
   * Returns the current step count for a session.
   *
   * @param sessionID - Session identifier
   * @returns Current step number
   */
  export function currentStep(sessionID: string): number {
    return getState(sessionID).currentStep
  }

  /**
   * Returns the number of tracked files for a session.
   *
   * @param sessionID - Session identifier
   * @returns File count
   */
  export function fileCount(sessionID: string): number {
    return getState(sessionID).files.size
  }

  // ─── Internal Helpers ────────────────────────────────────────

  /**
   * Normalizes a file path to be relative to the project root.
   *
   * @param filePath - Absolute or relative file path
   * @returns Relative path
   */
  function normalizePath(filePath: string): string {
    try {
      const root = Instance.worktree
      if (root && filePath.startsWith(root)) {
        const rel = filePath.slice(root.length)
        return rel.startsWith("/") ? rel.slice(1) : rel
      }
    } catch {
      // Instance not initialized — return as-is
    }
    return filePath
  }

  /**
   * Expands the working set by adding graph neighbors of a file.
   *
   * @param state - Working set state
   * @param filePath - File to expand from
   * @param baseRelevance - Relevance for neighbor files
   */
  function expandNeighbors(
    state: WorkingSet.State,
    filePath: string,
    baseRelevance: number,
  ): void {
    try {
      const projectID = Instance.project?.id
      if (!projectID) return

      const normalized = normalizePath(filePath)
      const nodes = Graph.nodesInFile(projectID, normalized)
      if (nodes.length === 0) return

      // Get callers of entities in this file
      for (const node of nodes.slice(0, 3)) {
        const callers = Graph.callersOf(projectID, node.name)
        for (const caller of callers.slice(0, 3)) {
          if (caller.filePath && caller.filePath !== normalized) {
            WorkingSet.touch(state, caller.filePath, baseRelevance * 0.7, `caller of ${node.name}`)
          }
        }
      }
    } catch {
      // Graph not available — skip expansion
    }
  }

  /**
   * Extracts file paths from tool output text.
   * Looks for common patterns like "path/to/file.ts" or "/abs/path/file.ts".
   *
   * @param output - Tool output text
   * @returns Array of file paths found
   */
  function extractFilePathsFromOutput(output: string): string[] {
    const files = new Set<string>()
    // Match lines that look like file paths
    const lines = output.split("\n")
    for (const line of lines) {
      // Match paths ending in common extensions
      const match = line.match(/(?:^|\s)((?:[\w./-]+\/)?[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|css|html|json|yaml|yml|toml|md|sql))\b/)
      if (match?.[1]) {
        files.add(match[1])
      }
    }
    return [...files]
  }

  /**
   * Extracts file paths specifically from error output (verification, compilation).
   * More aggressive matching for error-style paths like "src/foo.ts(10,5):" or "src/foo.ts:10:5".
   *
   * @param output - Error output text
   * @returns Array of file paths found
   */
  function extractFilePathsFromErrors(output: string): string[] {
    const files = new Set<string>()
    const lines = output.split("\n")
    for (const line of lines) {
      // TypeScript/tsgo style: "src/foo.ts(10,5): error TS..."
      const tsMatch = line.match(/^([\w./-]+\.(?:ts|tsx|js|jsx))\(\d+,\d+\)/)
      if (tsMatch?.[1]) {
        files.add(tsMatch[1])
        continue
      }
      // Go/generic style: "src/foo.go:10:5: ..."
      const genericMatch = line.match(/^([\w./-]+\.(?:ts|tsx|js|jsx|go|py|rs|java))\:\d+/)
      if (genericMatch?.[1]) {
        files.add(genericMatch[1])
        continue
      }
      // Rust style: " --> src/foo.rs:10:5"
      const rustMatch = line.match(/-->\s+([\w./-]+\.rs)\:\d+/)
      if (rustMatch?.[1]) {
        files.add(rustMatch[1])
      }
    }
    return [...files]
  }
}
