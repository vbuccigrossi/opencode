import { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"

/**
 * Scratchpad — collects the agent's internal reasoning from think tool
 * calls and formats them for system prompt injection.
 *
 * On each step, the accumulated scratchpad is injected into the system
 * prompt so the agent has a consolidated view of its reasoning. This is
 * especially valuable after compaction, when individual tool call outputs
 * may have been cleared but the thoughts (stored as tool inputs) survive.
 */
export namespace Scratchpad {
  const log = Log.create({ service: "scratchpad" })

  /** Default maximum number of thoughts to include in the system prompt block. */
  const DEFAULT_MAX_THOUGHTS = 20

  /** Default maximum total characters for the scratchpad block. */
  const DEFAULT_MAX_CHARS = 8000

  // OPT-1.2: Thought index — avoids re-scanning all messages every step
  const thoughtIndex = new Map<string, string[]>() // sessionID → thoughts

  /**
   * Appends a thought to the session index.
   * Call this when a think tool completes instead of re-scanning.
   */
  export function appendThought(sessionID: string, thought: string): void {
    const trimmed = thought.trim()
    if (!trimmed) return
    const existing = thoughtIndex.get(sessionID) ?? []
    existing.push(trimmed)
    thoughtIndex.set(sessionID, existing)
  }

  /** Returns indexed thoughts for a session, or undefined if not indexed. */
  export function getIndexedThoughts(sessionID: string): string[] | undefined {
    return thoughtIndex.get(sessionID)
  }

  /** Clears the thought index for a session (e.g., on compaction). */
  export function clearIndex(sessionID: string): void {
    thoughtIndex.delete(sessionID)
  }

  /**
   * Extracts think tool thoughts from the conversation messages.
   *
   * Scans all assistant messages for completed think tool calls
   * and extracts the thought content from their inputs.
   *
   * @param messages - Conversation messages with parts
   * @returns Array of thought strings, oldest first
   */
  export function extractThoughts(messages: MessageV2.WithParts[]): string[] {
    const thoughts: string[] = []

    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue
      for (const part of msg.parts) {
        if (
          part.type === "tool" &&
          part.tool === "think" &&
          (part.state.status === "completed" || part.state.status === "error")
        ) {
          const thought = part.state.input?.thought
          if (typeof thought === "string" && thought.trim().length > 0) {
            thoughts.push(thought.trim())
          }
        }
      }
    }

    return thoughts
  }

  /** Options for controlling scratchpad format output. */
  export interface FormatOptions {
    maxThoughts?: number
    maxChars?: number
  }

  /**
   * Formats accumulated thoughts into a system prompt block.
   *
   * Returns undefined if there are no thoughts to include.
   * Truncates to stay within token/character limits.
   *
   * @param messages - Conversation messages with parts
   * @param options - Optional budget overrides (from InjectionBudget)
   * @returns Formatted scratchpad block, or undefined if empty
   */
  export function format(messages: MessageV2.WithParts[], options?: FormatOptions & { sessionID?: string }): string | undefined {
    const maxThoughts = options?.maxThoughts ?? DEFAULT_MAX_THOUGHTS
    const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS

    // OPT-1.2: Use indexed thoughts if available, fall back to full scan
    const thoughts = (options?.sessionID && thoughtIndex.has(options.sessionID))
      ? thoughtIndex.get(options.sessionID)!
      : extractThoughts(messages)
    if (thoughts.length === 0) return undefined

    // Take the most recent thoughts, up to limit
    const recent = thoughts.slice(-maxThoughts)

    const lines: string[] = []
    lines.push("<scratchpad>")
    lines.push("Your internal reasoning from this session (use to stay on track):")
    lines.push("")

    let totalChars = lines.join("\n").length
    let included = 0

    for (let i = 0; i < recent.length; i++) {
      const entry = `[${i + 1}] ${recent[i]}`
      if (totalChars + entry.length + 1 > maxChars) {
        lines.push(`... (${recent.length - included} earlier thoughts omitted)`)
        break
      }
      lines.push(entry)
      totalChars += entry.length + 1
      included++
    }

    lines.push("</scratchpad>")
    return lines.join("\n")
  }
}
