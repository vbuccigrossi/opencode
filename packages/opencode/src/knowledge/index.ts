import { Log } from "@/util/log"
import { Extractor } from "./extractor"
import type { MessageV2 } from "@/session/message-v2"

/**
 * Knowledge extraction and retrieval system.
 *
 * Extracts structured facts from conversation messages before compaction,
 * stores them in memory, and retrieves relevant facts for context injection.
 *
 * Facts survive compaction because they are stored separately from the
 * conversation history. On subsequent turns, relevant facts are injected
 * into the system prompt to restore lost knowledge.
 */
export namespace Knowledge {
  const log = Log.create({ service: "knowledge" })

  /** Re-export types. */
  export type Fact = Extractor.Fact
  export type FactCategory = Extractor.FactCategory

  /** In-memory fact store, keyed by session. */
  const stores = new Map<string, Fact[]>()

  /** Max facts per session. */
  const MAX_FACTS = 100

  /** Max chars for formatted injection. */
  const DEFAULT_MAX_CHARS = 1000

  /**
   * Extract facts from conversation messages.
   *
   * Called before compaction to capture knowledge that would otherwise
   * be lost during summarization.
   *
   * @param messages - Conversation messages to scan
   * @returns Extracted facts
   */
  export function extract(messages: MessageV2.WithParts[]): Fact[] {
    return Extractor.extract(messages)
  }

  /**
   * Store facts for a session, deduplicating automatically.
   *
   * @param sessionID - Session identifier
   * @param facts - Facts to store
   * @returns Number of new facts added
   */
  export function store(sessionID: string, facts: Fact[]): number {
    let existing = stores.get(sessionID) ?? []
    let added = 0

    for (const fact of facts) {
      // Deduplicate by subject + content similarity
      const duplicate = existing.find(
        (f) =>
          f.category === fact.category &&
          f.subject === fact.subject &&
          similarity(f.content, fact.content) > 0.8,
      )

      if (duplicate) {
        // Update confidence if new fact is more confident
        if (fact.confidence > duplicate.confidence) {
          duplicate.confidence = fact.confidence
          duplicate.content = fact.content
        }
      } else {
        existing.push(fact)
        added++
      }
    }

    // Cap total facts
    if (existing.length > MAX_FACTS) {
      // Remove lowest confidence facts
      existing.sort((a, b) => b.confidence - a.confidence)
      existing = existing.slice(0, MAX_FACTS)
    }

    stores.set(sessionID, existing)

    if (added > 0) {
      log.info("facts stored", { sessionID: sessionID.slice(0, 8), added, total: existing.length })
    }

    return added
  }

  /**
   * Retrieve facts relevant to a context string.
   *
   * Scores each fact by term overlap with the context and returns
   * the top matches.
   *
   * @param sessionID - Session identifier
   * @param context - Context string to match against
   * @param maxFacts - Maximum facts to return (default: 10)
   * @returns Relevant facts, sorted by relevance
   */
  export function retrieve(
    sessionID: string,
    context?: string,
    maxFacts: number = 10,
  ): Fact[] {
    const facts = stores.get(sessionID) ?? []
    if (facts.length === 0) return []

    if (!context) {
      // No context — return highest confidence facts
      return [...facts]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxFacts)
    }

    // Score by term overlap with context
    const contextTerms = tokenize(context.toLowerCase())
    const scored = facts.map((fact) => {
      const factTerms = tokenize(`${fact.subject} ${fact.content}`.toLowerCase())
      const overlap = contextTerms.filter((t) => factTerms.includes(t)).length
      const score = (overlap / Math.max(contextTerms.length, 1)) * 0.7 + fact.confidence * 0.3
      return { fact, score }
    })

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFacts)
      .map(({ fact }) => fact)
  }

  /**
   * Format facts for system prompt injection.
   *
   * Groups facts by category and formats as an XML block,
   * respecting the character budget.
   *
   * @param sessionID - Session identifier
   * @param context - Optional context for relevance ranking
   * @param maxChars - Maximum characters (default: 1000)
   * @returns Formatted `<knowledge>` block, or empty string if no facts
   */
  export function format(
    sessionID: string,
    context?: string,
    maxChars: number = DEFAULT_MAX_CHARS,
  ): string {
    const facts = retrieve(sessionID, context, 15)
    if (facts.length === 0) return ""

    // Group by category
    const groups = new Map<Extractor.FactCategory, Fact[]>()
    for (const fact of facts) {
      const list = groups.get(fact.category) ?? []
      list.push(fact)
      groups.set(fact.category, list)
    }

    const sections: string[] = []
    let totalLength = 0

    const categoryLabels: Record<Extractor.FactCategory, string> = {
      file_role: "File Roles",
      code_pattern: "Code Patterns",
      error_pattern: "Error Patterns",
      convention: "Conventions",
      dependency: "Dependencies",
    }

    for (const [category, categoryFacts] of groups) {
      const label = categoryLabels[category] ?? category
      const lines: string[] = [`  [${label}]`]

      for (const fact of categoryFacts) {
        const line = `    - ${fact.content}`
        if (totalLength + line.length + 20 > maxChars) break
        lines.push(line)
        totalLength += line.length + 1
      }

      if (lines.length > 1) {
        sections.push(lines.join("\n"))
      }
    }

    if (sections.length === 0) return ""

    return `<knowledge>\n${sections.join("\n")}\n</knowledge>`
  }

  /**
   * Get all facts for a session.
   *
   * @param sessionID - Session identifier
   * @returns All stored facts
   */
  export function all(sessionID: string): Fact[] {
    return stores.get(sessionID) ?? []
  }

  /**
   * Get fact count for a session.
   *
   * @param sessionID - Session identifier
   * @returns Number of stored facts
   */
  export function count(sessionID: string): number {
    return (stores.get(sessionID) ?? []).length
  }

  /**
   * Clear facts for a session.
   *
   * @param sessionID - Session identifier
   */
  export function clear(sessionID: string): void {
    stores.delete(sessionID)
  }

  /**
   * Clear all stored facts.
   */
  export function clearAll(): void {
    stores.clear()
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Tokenize text into lowercase words. */
  function tokenize(text: string): string[] {
    return text
      .split(/[^a-zA-Z0-9]+/)
      .filter((w) => w.length > 2)
  }

  /** Simple term overlap similarity (0-1). */
  function similarity(a: string, b: string): number {
    const tokensA = new Set(tokenize(a.toLowerCase()))
    const tokensB = new Set(tokenize(b.toLowerCase()))
    if (tokensA.size === 0 && tokensB.size === 0) return 1
    if (tokensA.size === 0 || tokensB.size === 0) return 0

    let overlap = 0
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++
    }

    return overlap / Math.max(tokensA.size, tokensB.size)
  }
}
