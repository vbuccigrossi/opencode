import z from "zod"
import { Tool } from "./tool"
import { Memory } from "../memory"

/**
 * Remember tool — allows the agent to store, recall, search, and manage
 * persistent memories that survive across sessions.
 *
 * Memories are scoped per project and injected into the system prompt
 * at the start of each new session.
 */
export const RememberTool = Tool.define("remember", {
  description: [
    "Store and manage persistent memories that survive across sessions.",
    "Use this to remember important project knowledge, patterns, user preferences,",
    "debugging insights, and conventions you've learned.",
    "",
    "Operations:",
    "- store: Save a new memory (automatically deduplicates and consolidates similar entries)",
    "- recall: Fuzzy search for relevant memories by keyword (prefix-matching and bigram similarity)",
    "- list: Show all memories, optionally filtered by type",
    "- forget: Remove a memory by ID",
    "- stats: Show memory statistics (including decaying count)",
    "- consolidate: Merge semantically similar memories",
    "- prune: Remove memories not accessed in 90+ days",
    "",
    "Memory types: pattern, architecture, debugging, preference, convention",
    "",
    "Good memories are specific, factual, and reusable:",
    "  Good: 'This project uses Tool.define() pattern for all agent tools'",
    "  Bad: 'The code is complex' (too vague)",
  ].join("\n"),
  parameters: z.object({
    operation: z
      .enum(["store", "recall", "list", "forget", "stats", "consolidate", "prune"])
      .describe("The memory operation to perform"),
    content: z
      .string()
      .optional()
      .describe("For store: the memory to save. For recall: the search query."),
    type: z
      .enum(["pattern", "architecture", "debugging", "preference", "convention"])
      .optional()
      .describe("Memory category (required for store, optional filter for list)"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Optional tags for organizing memories (for store)"),
    id: z
      .string()
      .optional()
      .describe("Memory ID (for forget)"),
  }),
  async execute(params, ctx) {
    switch (params.operation) {
      case "store": {
        if (!params.content) {
          return {
            title: "Error",
            output: "The 'content' parameter is required for the store operation.",
            metadata: { truncated: false },
          }
        }
        if (!params.type) {
          return {
            title: "Error",
            output: "The 'type' parameter is required for the store operation.",
            metadata: { truncated: false },
          }
        }
        const entry = Memory.store(params.content, params.type, params.tags ?? [])
        return {
          title: `Stored: ${params.type}`,
          output: `Memory stored (${entry.id}):\n  Type: ${entry.type}\n  Content: ${entry.content}${entry.tags.length > 0 ? `\n  Tags: ${entry.tags.join(", ")}` : ""}`,
          metadata: { truncated: false },
        }
      }

      case "recall": {
        if (!params.content) {
          return {
            title: "Error",
            output: "The 'content' parameter is required as search query for the recall operation.",
            metadata: { truncated: false },
          }
        }
        // Use fuzzy search for better matching (prefix + bigram similarity)
        const fuzzyResults = Memory.fuzzySearch(params.content)
        // Also do exact substring search for precision
        const exactResults = Memory.search(params.content)
        // Merge: fuzzy results first, then exact results not already included
        const seenIds = new Set(fuzzyResults.map((r) => r.id))
        const combined = [...fuzzyResults]
        for (const r of exactResults) {
          if (!seenIds.has(r.id)) {
            combined.push({ ...r, score: 0 })
            seenIds.add(r.id)
          }
        }
        if (combined.length === 0) {
          return {
            title: "No matches",
            output: `No memories found matching "${params.content}".`,
            metadata: { truncated: false },
          }
        }
        const lines = combined.map(
          (r) => `[${r.id}] (${r.type}${r.score > 0 ? ` score:${r.score.toFixed(2)}` : ""}) ${r.content}${r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : ""}`,
        )
        return {
          title: `${combined.length} memories`,
          output: `Found ${combined.length} matching memories:\n${lines.join("\n")}`,
          metadata: { truncated: false },
        }
      }

      case "list": {
        const results = Memory.list(params.type as Memory.MemoryType | undefined)
        if (results.length === 0) {
          return {
            title: "Empty",
            output: params.type
              ? `No ${params.type} memories stored.`
              : "No memories stored yet.",
            metadata: { truncated: false },
          }
        }
        const lines = results.map(
          (r) => `[${r.id}] (${r.type}) ${r.content}${r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : ""}`,
        )
        return {
          title: `${results.length} memories`,
          output: `${results.length} memories:\n${lines.join("\n")}`,
          metadata: { truncated: false },
        }
      }

      case "forget": {
        if (!params.id) {
          return {
            title: "Error",
            output: "The 'id' parameter is required for the forget operation.",
            metadata: { truncated: false },
          }
        }
        const deleted = Memory.forget(params.id)
        return {
          title: deleted ? "Forgotten" : "Not found",
          output: deleted
            ? `Memory ${params.id} has been removed.`
            : `No memory found with ID ${params.id}.`,
          metadata: { truncated: false },
        }
      }

      case "stats": {
        const s = Memory.stats()
        const typeLines = Object.entries(s.byType)
          .map(([type, count]) => `  ${type}: ${count}`)
          .join("\n")
        return {
          title: `${s.total} memories`,
          output: `Memory statistics:\n  Total: ${s.total}\n  Decaying (30+ days unused): ${s.decaying}\n${typeLines || "  (none)"}`,
          metadata: { truncated: false },
        }
      }

      case "consolidate": {
        const merged = Memory.consolidate()
        return {
          title: merged > 0 ? `Consolidated ${merged}` : "No duplicates",
          output: merged > 0
            ? `Consolidated ${merged} duplicate memory pairs.`
            : "No semantically similar memories found to consolidate.",
          metadata: { truncated: false },
        }
      }

      case "prune": {
        const pruned = Memory.prune()
        return {
          title: pruned > 0 ? `Pruned ${pruned}` : "Nothing to prune",
          output: pruned > 0
            ? `Pruned ${pruned} stale memories (unused for 90+ days).`
            : "No stale memories to prune.",
          metadata: { truncated: false },
        }
      }
    }
  },
})
