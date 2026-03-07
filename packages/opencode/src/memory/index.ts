import { Database, eq, and, like, desc, lt } from "@/storage/db"
import { AgentMemoryTable } from "./schema.sql"
import { Instance } from "@/project/instance"
import { ulid } from "ulid"
import { Log } from "@/util/log"

/**
 * Persistent Agent Memory — cross-session learning that persists
 * knowledge, patterns, and conventions across conversations.
 *
 * Memories are scoped per project and stored in SQLite. They are
 * injected into the system prompt at the start of each session
 * so the agent can build on past experience.
 *
 * Memory types:
 * - pattern: Coding patterns and conventions (e.g., "uses NamedError for errors")
 * - architecture: Structural knowledge (e.g., "config has 7 precedence levels")
 * - debugging: Recurring issues and fixes (e.g., "WASM timeout needs 30s limit")
 * - preference: User workflow preferences (e.g., "prefers bun over npm")
 * - convention: Project conventions (e.g., "all tools use Tool.define pattern")
 */
export namespace Memory {
  const log = Log.create({ service: "memory" })

  /** Valid memory types. */
  export type MemoryType = "pattern" | "architecture" | "debugging" | "preference" | "convention"

  /** A single memory entry. */
  export interface Entry {
    id: string
    projectID: string
    content: string
    type: MemoryType
    tags: string[]
    timeCreated: number
    timeUpdated: number
    timeAccessed: number
    accessCount: number
  }

  /** A scored memory for relevance-ranked retrieval. */
  export interface ScoredEntry extends Entry {
    score: number
  }

  /** Maximum number of memories to inject into system prompt. */
  const MAX_MEMORIES = 30

  /** Maximum characters for the memory block. */
  const MAX_CHARS = 6000

  /** Minimum relevance score to include a memory in the system prompt. */
  const MIN_RELEVANCE_SCORE = 0.05

  /** Days of inactivity before a memory starts decaying. */
  const DECAY_START_DAYS = 30

  /** Days of inactivity before a memory is eligible for pruning. */
  const PRUNE_AFTER_DAYS = 90

  /**
   * Stores a new memory for the current project.
   * Checks for semantic duplicates and consolidates if found.
   *
   * @param content - The memory content (a clear, factual statement)
   * @param type - Category of memory
   * @param tags - Optional tags for filtering
   * @returns The created memory entry
   */
  export function store(
    content: string,
    type: MemoryType,
    tags: string[] = [],
  ): Entry {
    const projectID = Instance.project.id
    const now = Date.now()
    const id = `mem_${ulid()}`

    // Check for exact duplicates
    const existing = search(content.slice(0, 100))
    const duplicate = existing.find((e) =>
      e.content.toLowerCase().trim() === content.toLowerCase().trim(),
    )
    if (duplicate) {
      return update(duplicate.id, content)
    }

    // Check for semantic duplicates using fuzzy similarity
    const all = list()
    const similar = all.find((e) => {
      const sim = tokenSimilarity(content, e.content)
      return sim >= 0.8 && e.type === type
    })
    if (similar) {
      // Consolidate: keep the longer/newer content
      const merged = content.length >= similar.content.length ? content : similar.content
      return update(similar.id, merged)
    }

    Database.use((db) => {
      db.insert(AgentMemoryTable)
        .values({
          id,
          project_id: projectID,
          content: content.trim(),
          type,
          tags,
          time_created: now,
          time_updated: now,
          time_accessed: now,
          access_count: 0,
        })
        .run()
    })

    log.info("memory stored", { id, type, tags })

    return {
      id,
      projectID,
      content: content.trim(),
      type,
      tags,
      timeCreated: now,
      timeUpdated: now,
      timeAccessed: now,
      accessCount: 0,
    }
  }

  /**
   * Updates an existing memory.
   *
   * @param id - Memory ID
   * @param content - New content
   * @returns Updated entry
   */
  export function update(id: string, content: string): Entry {
    const now = Date.now()

    Database.use((db) => {
      db.update(AgentMemoryTable)
        .set({ content: content.trim(), time_updated: now })
        .where(eq(AgentMemoryTable.id, id))
        .run()
    })

    log.info("memory updated", { id })
    invalidateTokenCache(id) // OPT-5.1
    return get(id)!
  }

  /**
   * Retrieves a memory by ID.
   *
   * @param id - Memory ID
   * @returns Memory entry, or undefined if not found
   */
  export function get(id: string): Entry | undefined {
    const row = Database.use((db) =>
      db.select().from(AgentMemoryTable).where(eq(AgentMemoryTable.id, id)).get(),
    )
    return row ? fromRow(row) : undefined
  }

  /**
   * Removes a memory by ID.
   *
   * @param id - Memory ID
   * @returns true if the memory was deleted
   */
  export function forget(id: string): boolean {
    const exists = get(id)
    if (!exists) return false
    Database.use((db) =>
      db.delete(AgentMemoryTable).where(eq(AgentMemoryTable.id, id)).run(),
    )
    log.info("memory forgotten", { id })
    invalidateTokenCache(id) // OPT-5.1
    return true
  }

  /**
   * Lists all memories for the current project.
   *
   * @param type - Optional type filter
   * @returns Array of memory entries, most recently accessed first
   */
  export function list(type?: MemoryType): Entry[] {
    const projectID = Instance.project.id
    const conditions = [eq(AgentMemoryTable.project_id, projectID)]
    if (type) conditions.push(eq(AgentMemoryTable.type, type))

    const rows = Database.use((db) =>
      db
        .select()
        .from(AgentMemoryTable)
        .where(and(...conditions))
        .orderBy(desc(AgentMemoryTable.time_accessed))
        .all(),
    )
    return rows.map(fromRow)
  }

  /**
   * Searches memories by content substring match.
   *
   * @param query - Search query
   * @returns Matching memories
   */
  export function search(query: string): Entry[] {
    const projectID = Instance.project.id
    const rows = Database.use((db) =>
      db
        .select()
        .from(AgentMemoryTable)
        .where(
          and(
            eq(AgentMemoryTable.project_id, projectID),
            like(AgentMemoryTable.content, `%${query}%`),
          ),
        )
        .orderBy(desc(AgentMemoryTable.time_accessed))
        .limit(20)
        .all(),
    )
    return rows.map(fromRow)
  }

  // ─── 8.1: Relevance-Scored Retrieval ────────────────────────────

  /**
   * Scores and ranks all memories against a context string.
   * Uses term overlap, recency, frequency, type affinity, and tag matching.
   *
   * @param context - Current context to score against (e.g., user message or file content)
   * @param affinityType - Boost memories of this type (e.g., "debugging" when errors present)
   * @returns Scored entries sorted by relevance, filtered above MIN_RELEVANCE_SCORE
   */
  export function scored(context?: string, affinityType?: MemoryType): ScoredEntry[] {
    const memories = list()
    if (memories.length === 0) return []

    const now = Date.now()
    const contextTokens = context ? tokenize(context) : []

    const scored: ScoredEntry[] = memories.map((entry) => ({
      ...entry,
      score: computeRelevanceScore(entry, contextTokens, now, affinityType),
    }))

    return scored
      .filter((e) => e.score >= MIN_RELEVANCE_SCORE)
      .sort((a, b) => b.score - a.score)
  }

  /**
   * Computes composite relevance score for a memory.
   *
   * Signals:
   * - Term overlap (40%): shared tokens between context and memory
   * - Recency (25%): exponential decay based on time since last access
   * - Frequency (15%): logarithmic boost for frequently accessed memories
   * - Type affinity (10%): bonus when memory type matches current task
   * - Tag match (10%): bonus when tags overlap with context tokens
   */
  // OPT-5.1: Cache tokenized content per memory entry
  const tokenCache = new Map<string, Set<string>>()

  function getCachedTokens(entry: Entry): Set<string> {
    let cached = tokenCache.get(entry.id)
    if (!cached) {
      const memoryTokens = tokenize(entry.content)
      const tagTokens = entry.tags.flatMap((t) => tokenize(t))
      cached = new Set([...memoryTokens, ...tagTokens])
      tokenCache.set(entry.id, cached)
    }
    return cached
  }

  /** Invalidate token cache for an entry (call on update/delete). */
  export function invalidateTokenCache(entryId: string): void {
    tokenCache.delete(entryId)
  }

  function computeRelevanceScore(
    entry: Entry,
    contextTokens: string[],
    now: number,
    affinityType?: MemoryType,
  ): number {
    // Term overlap: shared tokens / max tokens
    let termScore = 0
    if (contextTokens.length > 0) {
      // OPT-5.1: Use cached tokenized content
      const allMemoryTokens = getCachedTokens(entry)
      const shared = contextTokens.filter((t) => allMemoryTokens.has(t)).length
      termScore = shared / Math.max(contextTokens.length, 1)
    }

    // Recency: exponential decay — halves every 7 days of inactivity
    const daysSinceAccess = (now - entry.timeAccessed) / (1000 * 60 * 60 * 24)
    const recencyScore = Math.pow(0.5, daysSinceAccess / 7)

    // Frequency: logarithmic boost (diminishing returns)
    const frequencyScore = Math.min(1, Math.log2(entry.accessCount + 1) / 5)

    // Type affinity: bonus when types match
    const typeScore = affinityType && entry.type === affinityType ? 1 : 0

    // Tag match: check if any tags match context tokens
    let tagScore = 0
    if (contextTokens.length > 0 && entry.tags.length > 0) {
      const contextSet = new Set(contextTokens)
      const tagMatches = entry.tags.filter((t) =>
        tokenize(t).some((tok) => contextSet.has(tok)),
      ).length
      tagScore = tagMatches / entry.tags.length
    }

    // Weighted composite
    return (
      termScore * 0.4 +
      recencyScore * 0.25 +
      frequencyScore * 0.15 +
      typeScore * 0.1 +
      tagScore * 0.1
    )
  }

  // ─── 8.2: Fuzzy Search ─────────────────────────────────────────

  /**
   * Fuzzy search over all memories using word-level prefix matching
   * and bigram similarity scoring.
   *
   * @param query - Search query (fuzzy matched)
   * @param threshold - Minimum similarity threshold (0-1, default 0.3)
   * @returns Matching entries sorted by similarity score
   */
  export function fuzzySearch(query: string, threshold: number = 0.3): ScoredEntry[] {
    const memories = list()
    if (memories.length === 0 || query.trim().length === 0) return []

    const queryTokens = tokenize(query)
    const queryBigrams = bigrams(query.toLowerCase())

    const results: ScoredEntry[] = []

    for (const entry of memories) {
      const contentTokens = tokenize(entry.content)
      const tagTokens = entry.tags.flatMap((t) => tokenize(t))
      const allTokens = [...contentTokens, ...tagTokens]

      // Word-level prefix matching
      const prefixMatches = queryTokens.filter((qt) =>
        allTokens.some((ct) => ct.startsWith(qt) || qt.startsWith(ct)),
      ).length
      const prefixScore = prefixMatches / Math.max(queryTokens.length, 1)

      // Bigram similarity
      const contentBigrams = bigrams(entry.content.toLowerCase())
      const bigramScore = bigramSimilarity(queryBigrams, contentBigrams)

      // Combined fuzzy score
      const score = prefixScore * 0.6 + bigramScore * 0.4

      if (score >= threshold) {
        results.push({ ...entry, score })
      }
    }

    return results.sort((a, b) => b.score - a.score)
  }

  /**
   * Tokenizes text into lowercase words, stripping punctuation.
   * Shared between relevance scoring and fuzzy search.
   */
  export function tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  }

  /**
   * Generates character bigrams from a string.
   *
   * @param text - Input text
   * @returns Set of 2-character substrings
   */
  export function bigrams(text: string): Set<string> {
    const result = new Set<string>()
    const clean = text.replace(/\s+/g, " ").trim()
    for (let i = 0; i < clean.length - 1; i++) {
      result.add(clean.slice(i, i + 2))
    }
    return result
  }

  /**
   * Computes Dice coefficient between two bigram sets.
   *
   * @param a - First bigram set
   * @param b - Second bigram set
   * @returns Similarity score between 0 and 1
   */
  export function bigramSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1
    if (a.size === 0 || b.size === 0) return 0
    let intersection = 0
    for (const bg of a) {
      if (b.has(bg)) intersection++
    }
    return (2 * intersection) / (a.size + b.size)
  }

  /**
   * Token-level similarity between two strings.
   * Used for consolidation duplicate detection.
   *
   * @param a - First string
   * @param b - Second string
   * @returns Similarity score between 0 and 1
   */
  export function tokenSimilarity(a: string, b: string): number {
    const tokensA = new Set(tokenize(a))
    const tokensB = new Set(tokenize(b))
    if (tokensA.size === 0 && tokensB.size === 0) return 1
    if (tokensA.size === 0 || tokensB.size === 0) return 0
    let intersection = 0
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++
    }
    return (2 * intersection) / (tokensA.size + tokensB.size)
  }

  // ─── 8.3: Automatic Memory Extraction ──────────────────────────

  /** Keywords that suggest a statement is a generalizable insight. */
  const INSIGHT_MARKERS = [
    "always", "never", "must", "convention", "pattern",
    "requires", "expects", "prefers", "uses", "needs",
    "important", "note that", "remember",
  ]

  /**
   * Extracts candidate memories from session messages.
   * Scans think tool thoughts and assistant text for generalizable insights.
   *
   * Returns candidates (not auto-stored) so the caller can decide what to keep.
   *
   * @param messages - Session messages with parts
   * @returns Array of candidate memories with suggested types
   */
  export function extractCandidates(
    messages: Array<{ info: { role: string }; parts: Array<any> }>,
  ): Array<{ content: string; type: MemoryType; source: "think" | "text" }> {
    const candidates: Array<{ content: string; type: MemoryType; source: "think" | "text" }> = []
    const seen = new Set<string>()

    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue

      for (const part of msg.parts) {
        // Extract from think tool thoughts
        if (
          part.type === "tool" &&
          part.tool === "think" &&
          part.state?.status === "completed"
        ) {
          const thought = part.state.input?.thought
          if (typeof thought === "string") {
            const extracted = extractInsightsFromText(thought, "think")
            for (const c of extracted) {
              const key = c.content.toLowerCase().trim()
              if (!seen.has(key)) {
                seen.add(key)
                candidates.push(c)
              }
            }
          }
        }

        // Extract from assistant text parts
        if (part.type === "text" && typeof part.content === "string") {
          const extracted = extractInsightsFromText(part.content, "text")
          for (const c of extracted) {
            const key = c.content.toLowerCase().trim()
            if (!seen.has(key)) {
              seen.add(key)
              candidates.push(c)
            }
          }
        }
      }
    }

    return candidates
  }

  /**
   * Extracts generalizable insight sentences from text.
   * Looks for sentences containing insight marker keywords.
   */
  function extractInsightsFromText(
    text: string,
    source: "think" | "text",
  ): Array<{ content: string; type: MemoryType; source: "think" | "text" }> {
    const results: Array<{ content: string; type: MemoryType; source: "think" | "text" }> = []

    // Split into sentences
    const sentences = text
      .split(/[.!?\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 20 && s.length <= 200)

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()

      // Must contain at least one insight marker
      const hasMarker = INSIGHT_MARKERS.some((m) => lower.includes(m))
      if (!hasMarker) continue

      // Skip task-specific or self-referential statements
      if (lower.includes("i will") || lower.includes("i'll") || lower.includes("let me")) continue
      if (lower.includes("the user") || lower.includes("user asked")) continue

      const type = inferMemoryType(sentence)
      results.push({ content: sentence, type, source })
    }

    return results
  }

  /**
   * Infers the most appropriate memory type for a piece of text.
   */
  function inferMemoryType(text: string): MemoryType {
    const lower = text.toLowerCase()
    if (lower.includes("error") || lower.includes("fix") || lower.includes("bug") || lower.includes("timeout")) {
      return "debugging"
    }
    if (lower.includes("prefers") || lower.includes("preference") || lower.includes("workflow")) {
      return "preference"
    }
    if (lower.includes("architecture") || lower.includes("structure") || lower.includes("module") || lower.includes("layer")) {
      return "architecture"
    }
    if (lower.includes("convention") || lower.includes("naming") || lower.includes("style")) {
      return "convention"
    }
    return "pattern"
  }

  // ─── 8.4: Memory Consolidation & Decay ─────────────────────────

  /**
   * Consolidates semantically similar memories by merging them.
   * Scans all memories and merges pairs with >= 80% token similarity.
   *
   * @returns Number of memories merged
   */
  export function consolidate(): number {
    const memories = list()
    if (memories.length < 2) return 0

    let merged = 0
    const removed = new Set<string>()

    for (let i = 0; i < memories.length; i++) {
      if (removed.has(memories[i].id)) continue

      for (let j = i + 1; j < memories.length; j++) {
        if (removed.has(memories[j].id)) continue
        if (memories[i].type !== memories[j].type) continue

        const sim = tokenSimilarity(memories[i].content, memories[j].content)
        if (sim >= 0.8) {
          // Keep the one with more access or longer content
          const keep = memories[i].accessCount >= memories[j].accessCount ? memories[i] : memories[j]
          const discard = keep === memories[i] ? memories[j] : memories[i]
          const content = keep.content.length >= discard.content.length ? keep.content : discard.content
          update(keep.id, content)
          forget(discard.id)
          removed.add(discard.id)
          merged++
          log.info("memory consolidated", { kept: keep.id, removed: discard.id })
        }
      }
    }

    return merged
  }

  /**
   * Prunes stale memories that haven't been accessed for a long time.
   *
   * @param daysUnused - Days of inactivity before pruning (default: PRUNE_AFTER_DAYS)
   * @returns Number of memories pruned
   */
  export function prune(daysUnused: number = PRUNE_AFTER_DAYS): number {
    const cutoff = Date.now() - daysUnused * 24 * 60 * 60 * 1000
    const projectID = Instance.project.id

    const stale = Database.use((db) =>
      db
        .select()
        .from(AgentMemoryTable)
        .where(
          and(
            eq(AgentMemoryTable.project_id, projectID),
            lt(AgentMemoryTable.time_accessed, cutoff),
          ),
        )
        .all(),
    )

    for (const row of stale) {
      Database.use((db) =>
        db.delete(AgentMemoryTable).where(eq(AgentMemoryTable.id, row.id)).run(),
      )
    }

    if (stale.length > 0) {
      log.info("memories pruned", { count: stale.length, daysUnused })
    }

    return stale.length
  }

  /**
   * Returns stale memory IDs (accessed before decay start threshold).
   * Useful for flagging entries that may need review.
   *
   * @returns Array of entries that are decaying
   */
  export function decaying(): Entry[] {
    const cutoff = Date.now() - DECAY_START_DAYS * 24 * 60 * 60 * 1000
    const projectID = Instance.project.id

    const rows = Database.use((db) =>
      db
        .select()
        .from(AgentMemoryTable)
        .where(
          and(
            eq(AgentMemoryTable.project_id, projectID),
            lt(AgentMemoryTable.time_accessed, cutoff),
          ),
        )
        .orderBy(desc(AgentMemoryTable.time_accessed))
        .all(),
    )

    return rows.map(fromRow)
  }

  /**
   * Marks memories as accessed (updates access time and count).
   * Called when memories are injected into the system prompt.
   *
   * @param ids - Memory IDs to mark
   */
  function markAccessed(ids: string[]): void {
    if (ids.length === 0) return
    const now = Date.now()
    Database.use((db) => {
      for (const id of ids) {
        db.update(AgentMemoryTable)
          .set({
            time_accessed: now,
            access_count: Database.use((innerDb) => {
              const row = innerDb
                .select({ count: AgentMemoryTable.access_count })
                .from(AgentMemoryTable)
                .where(eq(AgentMemoryTable.id, id))
                .get()
              return (row?.count ?? 0) + 1
            }),
          })
          .where(eq(AgentMemoryTable.id, id))
          .run()
      }
    })
  }

  /** Options for controlling memory format output. */
  export interface FormatOptions {
    context?: string
    affinityType?: MemoryType
    maxChars?: number
    maxEntries?: number
  }

  /**
   * Formats memories for injection into the system prompt.
   *
   * Uses relevance scoring when context is available, otherwise falls
   * back to recency-based ordering. Only includes memories above the
   * minimum relevance threshold.
   *
   * @param contextOrOptions - Context string or full options object
   * @param affinityType - Optional type to boost (when first arg is string)
   * @returns Formatted memory block, or undefined if empty
   */
  export function format(contextOrOptions?: string | FormatOptions, affinityType?: MemoryType): string | undefined {
    let context: string | undefined
    let maxChars = MAX_CHARS
    let maxEntries = MAX_MEMORIES

    if (typeof contextOrOptions === "string") {
      context = contextOrOptions
    } else if (contextOrOptions) {
      context = contextOrOptions.context
      affinityType = contextOrOptions.affinityType ?? affinityType
      maxChars = contextOrOptions.maxChars ?? MAX_CHARS
      maxEntries = contextOrOptions.maxEntries ?? MAX_MEMORIES
    }

    let memories: (Entry | ScoredEntry)[]

    if (context) {
      memories = scored(context, affinityType)
    } else {
      memories = list()
    }

    if (memories.length === 0) return undefined

    const lines: string[] = []
    lines.push("<agent-memory>")
    lines.push("Learned knowledge from previous sessions (use to avoid repeating mistakes):")
    lines.push("")

    let totalChars = lines.join("\n").length
    const included: string[] = []
    const grouped = groupByType(memories)

    for (const [type, entries] of grouped) {
      const header = `## ${typeLabel(type)}`
      if (totalChars + header.length + 1 > maxChars) break
      lines.push(header)
      totalChars += header.length + 1

      for (const entry of entries) {
        if (included.length >= maxEntries) break
        const line = `- ${entry.content}${entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : ""}`
        if (totalChars + line.length + 1 > maxChars) break
        lines.push(line)
        totalChars += line.length + 1
        included.push(entry.id)
      }
      lines.push("")
    }

    if (included.length === 0) return undefined

    lines.push("</agent-memory>")

    // Mark all included memories as accessed
    markAccessed(included)

    return lines.join("\n")
  }

  /**
   * Returns memory statistics for the current project.
   */
  export function stats(): { total: number; byType: Record<string, number>; decaying: number } {
    const memories = list()
    const byType: Record<string, number> = {}
    for (const m of memories) {
      byType[m.type] = (byType[m.type] ?? 0) + 1
    }
    const staleCount = decaying().length
    return { total: memories.length, byType, decaying: staleCount }
  }

  /** Groups memories by type for formatted output. */
  function groupByType(memories: (Entry | ScoredEntry)[]): [MemoryType, (Entry | ScoredEntry)[]][] {
    const groups = new Map<MemoryType, (Entry | ScoredEntry)[]>()
    for (const m of memories) {
      const list = groups.get(m.type) ?? []
      list.push(m)
      groups.set(m.type, list)
    }
    return Array.from(groups.entries())
  }

  /** Human-readable type labels. */
  function typeLabel(type: MemoryType): string {
    switch (type) {
      case "pattern": return "Patterns & Conventions"
      case "architecture": return "Architecture"
      case "debugging": return "Debugging Insights"
      case "preference": return "User Preferences"
      case "convention": return "Project Conventions"
    }
  }

  /** Converts a database row to a Memory.Entry. */
  function fromRow(row: typeof AgentMemoryTable.$inferSelect): Entry {
    return {
      id: row.id,
      projectID: row.project_id,
      content: row.content,
      type: row.type as MemoryType,
      tags: (row.tags ?? []) as string[],
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      timeAccessed: row.time_accessed,
      accessCount: row.access_count,
    }
  }
}
