import { Log } from "@/util/log"

/**
 * Real-time correction learning — detects when the user corrects or
 * redirects the agent within a session, and maintains a session-local
 * list of corrections for system prompt injection.
 *
 * This is intra-session adaptation: the agent becomes more aligned with
 * user expectations as the conversation progresses. Different from Memory
 * (which is cross-session and persistent).
 */
export namespace Correction {
  const log = Log.create({ service: "correction" })

  /** A detected correction from user input. */
  export interface CorrectionEntry {
    /** What the user corrected — extracted instruction. */
    instruction: string
    /** Category of correction. */
    category: CorrectionCategory
    /** How many times this correction (or similar) has been reinforced. */
    strength: number
    /** Timestamp of first detection. */
    firstSeen: number
    /** Timestamp of most recent reinforcement. */
    lastSeen: number
  }

  /** Categories of corrections. */
  export type CorrectionCategory =
    | "approach"     // "don't refactor, just fix the bug"
    | "style"        // "use snake_case" / "shorter responses"
    | "scope"        // "only change this file" / "don't touch tests"
    | "tool_use"     // "use grep not bash" / "don't run tests yet"
    | "output"       // "show me the diff" / "be more concise"
    | "preference"   // "always use X" / "never do Y"

  /** Correction signal — a pattern that indicates the user is correcting. */
  interface CorrectionSignal {
    /** Regex pattern to detect the signal. */
    pattern: RegExp
    /** Weight of this signal (higher = more likely a correction). */
    weight: number
    /** Likely category for this signal type. */
    category: CorrectionCategory
  }

  /** Detection signals for different correction types. */
  const SIGNALS: CorrectionSignal[] = [
    // Negation signals
    { pattern: /\bno[,.]?\s+(don'?t|do not|stop|quit)\b/i, weight: 0.9, category: "approach" },
    { pattern: /\bdon'?t\s+\w+/i, weight: 0.7, category: "approach" },
    { pattern: /\bdo\s+not\s+\w+/i, weight: 0.7, category: "approach" },
    { pattern: /\bstop\s+(doing|adding|changing|creating|running)\b/i, weight: 0.8, category: "approach" },
    { pattern: /\bnot\s+what\s+I\s+(asked|wanted|meant)/i, weight: 0.95, category: "approach" },

    // Redirection signals
    { pattern: /\binstead[,.]?\s/i, weight: 0.6, category: "approach" },
    { pattern: /\bactually[,.]?\s/i, weight: 0.5, category: "approach" },
    { pattern: /\bI\s+meant\b/i, weight: 0.8, category: "approach" },
    { pattern: /\brather\s+than\b/i, weight: 0.5, category: "approach" },
    { pattern: /\bI\s+said\b/i, weight: 0.7, category: "approach" },

    // Preference signals
    { pattern: /\balways\s+\w+/i, weight: 0.7, category: "preference" },
    { pattern: /\bnever\s+\w+/i, weight: 0.8, category: "preference" },
    { pattern: /\bprefer\s+\w+/i, weight: 0.6, category: "preference" },
    { pattern: /\bI\s+(like|hate|want|need)\s/i, weight: 0.5, category: "preference" },

    // Style signals
    { pattern: /\b(shorter|longer|more\s+concise|less\s+verbose|briefer)\b/i, weight: 0.7, category: "style" },
    { pattern: /\b(snake_case|camelCase|PascalCase|kebab-case)\b/i, weight: 0.8, category: "style" },
    { pattern: /\btoo\s+(much|many|long|short|verbose)\b/i, weight: 0.6, category: "style" },

    // Scope signals
    { pattern: /\bonly\s+(change|edit|modify|touch|update)\s/i, weight: 0.7, category: "scope" },
    { pattern: /\bdon'?t\s+(touch|change|modify|edit)\s/i, weight: 0.8, category: "scope" },
    { pattern: /\bjust\s+(fix|change|update|add)\b/i, weight: 0.5, category: "scope" },
    { pattern: /\bleave\s+\S+\s+alone\b/i, weight: 0.8, category: "scope" },

    // Tool use signals
    { pattern: /\buse\s+(grep|glob|read|bash|edit|write)\b/i, weight: 0.7, category: "tool_use" },
    { pattern: /\bdon'?t\s+(use|run|call|invoke)\s/i, weight: 0.7, category: "tool_use" },

    // Frustration signals (strongest corrections)
    { pattern: /\bI\s+already\s+(said|told|asked|mentioned)\b/i, weight: 0.95, category: "approach" },
    { pattern: /\bagain[,!.]/i, weight: 0.4, category: "approach" },
    { pattern: /\bwrong\b/i, weight: 0.6, category: "approach" },
    { pattern: /\bthat'?s?\s+not\s+(right|correct|what)\b/i, weight: 0.8, category: "approach" },
  ]

  /** Minimum signal weight to consider a message as containing a correction. */
  const MIN_SIGNAL_WEIGHT = 0.5

  /** Maximum corrections to track per session. */
  const MAX_CORRECTIONS = 20

  /** Maximum corrections to inject into system prompt. */
  const MAX_INJECTED = 10

  /** Per-session correction state. */
  const sessions = new Map<string, CorrectionEntry[]>()

  /**
   * Analyze a user message for corrections and update the session state.
   *
   * @param sessionID - Session identifier
   * @param text - User message text
   * @returns Newly detected corrections (may be empty)
   */
  export function analyze(sessionID: string, text: string): CorrectionEntry[] {
    if (!text || text.length < 3) return []

    const detected: CorrectionEntry[] = []
    const corrections = sessions.get(sessionID) ?? []

    // Check each signal pattern
    for (const signal of SIGNALS) {
      const match = text.match(signal.pattern)
      if (!match || signal.weight < MIN_SIGNAL_WEIGHT) continue

      // Extract the instruction — take the sentence containing the match
      const instruction = extractInstruction(text, match.index ?? 0)
      if (!instruction) continue

      const category = categorize(instruction, signal.category)

      // Check for duplicate/reinforcement
      const existing = findSimilar(corrections, instruction)
      if (existing) {
        existing.strength = Math.min(existing.strength + 0.5, 3.0)
        existing.lastSeen = Date.now()
        log.info("correction reinforced", {
          sessionID,
          instruction: existing.instruction,
          strength: existing.strength,
        })
      } else {
        const entry: CorrectionEntry = {
          instruction,
          category,
          strength: signal.weight,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
        }
        corrections.push(entry)
        detected.push(entry)
        log.info("correction detected", {
          sessionID,
          instruction,
          category,
          weight: signal.weight,
        })
      }
    }

    // Trim to max size
    while (corrections.length > MAX_CORRECTIONS) {
      // Remove the weakest, oldest correction
      let minIdx = 0
      let minScore = Infinity
      for (let i = 0; i < corrections.length; i++) {
        const score = corrections[i].strength * (1 + (corrections[i].lastSeen - corrections[i].firstSeen) / 60_000)
        if (score < minScore) {
          minScore = score
          minIdx = i
        }
      }
      corrections.splice(minIdx, 1)
    }

    sessions.set(sessionID, corrections)
    return detected
  }

  /**
   * Get all corrections for a session, sorted by strength (strongest first).
   *
   * @param sessionID - Session identifier
   * @returns Array of corrections
   */
  export function get(sessionID: string): CorrectionEntry[] {
    const corrections = sessions.get(sessionID) ?? []
    return [...corrections].sort((a, b) => b.strength - a.strength)
  }

  /**
   * Format corrections as a system prompt block.
   *
   * Only includes corrections above a strength threshold.
   * Returns undefined if no corrections are worth injecting.
   *
   * @param sessionID - Session identifier
   * @returns Formatted `<corrections>` block, or undefined
   */
  export function format(sessionID: string): string | undefined {
    const corrections = get(sessionID)
    if (corrections.length === 0) return undefined

    // Only inject corrections with meaningful strength
    const worthy = corrections
      .filter((c) => c.strength >= 0.5)
      .slice(0, MAX_INJECTED)

    if (worthy.length === 0) return undefined

    const lines: string[] = ["<corrections>"]
    lines.push("The user has corrected or redirected you during this session. Follow these instructions carefully:")
    lines.push("")

    // Group by category for readability
    const grouped = new Map<CorrectionCategory, CorrectionEntry[]>()
    for (const c of worthy) {
      const list = grouped.get(c.category) ?? []
      list.push(c)
      grouped.set(c.category, list)
    }

    for (const [category, entries] of grouped) {
      for (const entry of entries) {
        const emphasis = entry.strength >= 2.0 ? " [STRONG]" : entry.strength >= 1.5 ? " [reinforced]" : ""
        lines.push(`- [${category}]${emphasis} ${entry.instruction}`)
      }
    }

    lines.push("</corrections>")
    return lines.join("\n")
  }

  /**
   * Clear corrections for a session.
   *
   * @param sessionID - Session identifier
   */
  export function clear(sessionID: string): void {
    sessions.delete(sessionID)
  }

  /**
   * Get the count of active corrections for a session.
   *
   * @param sessionID - Session identifier
   * @returns Number of corrections tracked
   */
  export function count(sessionID: string): number {
    return (sessions.get(sessionID) ?? []).length
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Extract the instructional sentence from the user's message.
   * Takes the sentence containing the signal match and cleans it up.
   */
  function extractInstruction(text: string, matchIndex: number): string | undefined {
    // Find sentence boundaries around the match
    const beforeMatch = text.slice(0, matchIndex)
    const afterMatch = text.slice(matchIndex)

    // Find start of sentence
    const sentenceStartPatterns = [/[.!?]\s+[A-Z]/g, /\n/g]
    let start = 0
    for (const pattern of sentenceStartPatterns) {
      let lastMatch: RegExpExecArray | null = null
      let m: RegExpExecArray | null
      while ((m = pattern.exec(beforeMatch)) !== null) {
        lastMatch = m
      }
      if (lastMatch) {
        const candidate = lastMatch.index + lastMatch[0].length - 1
        if (candidate > start) start = candidate
      }
    }

    // Find end of sentence
    const endMatch = afterMatch.match(/[.!?\n]/)
    const end = matchIndex + (endMatch ? (endMatch.index ?? afterMatch.length) + 1 : afterMatch.length)

    const sentence = text.slice(start, end).trim()
    if (sentence.length < 5 || sentence.length > 200) return undefined

    return sentence
  }

  /**
   * Determine the category of a correction based on its content.
   * Falls back to the signal's default category.
   */
  function categorize(instruction: string, defaultCategory: CorrectionCategory): CorrectionCategory {
    const lower = instruction.toLowerCase()

    // Check style before tool_use — style keywords are more specific
    if (/\b(concise|verbose|short|long|brief|format|snake_case|camelcase|pascalcase|kebab)\b/i.test(lower)) return "style"
    if (/\b(only|just|don't touch|leave.*alone|scope)\b/.test(lower)) return "scope"
    if (/\b(always|never|prefer|like|hate)\b/.test(lower)) return "preference"
    // Tool use — require specific tool names, not just bare "use"
    if (/\b(don't use|use (grep|glob|read|bash|edit|write))\b/.test(lower)) return "tool_use"
    if (/\b(output|show|display|print|return)\b/.test(lower)) return "output"

    return defaultCategory
  }

  /**
   * Find a similar existing correction using simple term overlap.
   * This prevents near-duplicate corrections from stacking.
   */
  function findSimilar(corrections: CorrectionEntry[], instruction: string): CorrectionEntry | undefined {
    const words = new Set(instruction.toLowerCase().split(/\s+/).filter((w) => w.length > 3))
    if (words.size === 0) return undefined

    for (const existing of corrections) {
      const existingWords = new Set(existing.instruction.toLowerCase().split(/\s+/).filter((w) => w.length > 3))
      if (existingWords.size === 0) continue

      // Calculate Jaccard similarity
      let intersection = 0
      for (const w of words) {
        if (existingWords.has(w)) intersection++
      }
      const union = new Set([...words, ...existingWords]).size
      const similarity = intersection / union

      if (similarity >= 0.5) return existing
    }

    return undefined
  }
}
