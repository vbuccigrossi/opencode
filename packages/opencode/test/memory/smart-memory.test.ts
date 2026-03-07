import { describe, expect, test } from "bun:test"
import { Memory } from "../../src/memory"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("memory.scoring", () => {
  test(
    "scores memories by term overlap with context",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses NamedError for error handling", "pattern", ["errors"])
          Memory.store("Config has 7 precedence levels", "architecture")
          Memory.store("WASM grammars need 30s timeout", "debugging")

          const results = Memory.scored("error handling NamedError")
          expect(results.length).toBeGreaterThanOrEqual(1)
          // The error-related memory should score highest
          expect(results[0].content).toContain("NamedError")
          expect(results[0].score).toBeGreaterThan(0)
        },
      })
    },
    30_000,
  )

  test(
    "boosts memories by type affinity",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Timeout errors need 30s limit", "debugging")
          Memory.store("Timeout config in settings", "architecture")

          const debugResults = Memory.scored("timeout", "debugging")
          const archResults = Memory.scored("timeout", "architecture")

          // Both should find the timeout memories, but affinity should boost the matching type
          const debugScore = debugResults.find((r) => r.type === "debugging")?.score ?? 0
          const archScoreInDebug = debugResults.find((r) => r.type === "architecture")?.score ?? 0

          // Debugging type should score higher when debugging affinity is set
          expect(debugScore).toBeGreaterThan(archScoreInDebug)
        },
      })
    },
    30_000,
  )

  test(
    "scored returns empty for no memories",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const results = Memory.scored("anything")
          expect(results).toHaveLength(0)
        },
      })
    },
    30_000,
  )

  test(
    "scored without context returns recency-based results",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Some pattern", "pattern")
          Memory.store("Some convention", "convention")

          // Without context, all memories should still appear (recency score > threshold)
          const results = Memory.scored()
          expect(results.length).toBeGreaterThanOrEqual(2)
        },
      })
    },
    30_000,
  )
})

describe("memory.fuzzySearch", () => {
  test(
    "finds memories with prefix matching",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses NamedError for error handling", "pattern")
          Memory.store("Config has 7 precedence levels", "architecture")

          // "NamedErr" should prefix-match "namederror"
          const results = Memory.fuzzySearch("NamedErr")
          expect(results.length).toBeGreaterThanOrEqual(1)
          expect(results[0].content).toContain("NamedError")
        },
      })
    },
    30_000,
  )

  test(
    "finds memories with bigram similarity",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("WASM grammars need 30s timeout", "debugging")

          // "wasm grammar timeout" should match via bigram overlap
          const results = Memory.fuzzySearch("wasm grammar timeout")
          expect(results.length).toBeGreaterThanOrEqual(1)
          expect(results[0].content).toContain("WASM")
        },
      })
    },
    30_000,
  )

  test(
    "respects threshold parameter",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses NamedError for error handling", "pattern")

          // Very high threshold should return nothing
          const strict = Memory.fuzzySearch("something unrelated", 0.99)
          expect(strict).toHaveLength(0)

          // Very low threshold should return everything
          const loose = Memory.fuzzySearch("error", 0.01)
          expect(loose.length).toBeGreaterThanOrEqual(1)
        },
      })
    },
    30_000,
  )

  test(
    "returns empty for empty query",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Some memory", "pattern")
          const results = Memory.fuzzySearch("")
          expect(results).toHaveLength(0)
        },
      })
    },
    30_000,
  )

  test(
    "matches against tags too",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Tool.define() pattern for tools", "pattern", ["tooling", "registry"])

          // "tooling" matches a tag
          const results = Memory.fuzzySearch("tooling")
          expect(results.length).toBeGreaterThanOrEqual(1)
        },
      })
    },
    30_000,
  )
})

describe("memory.tokenize", () => {
  test("splits text into lowercase tokens", () => {
    const tokens = Memory.tokenize("Uses NamedError for Error handling!")
    expect(tokens).toContain("uses")
    expect(tokens).toContain("namederror")
    expect(tokens).toContain("error")
    expect(tokens).toContain("handling")
  })

  test("filters out short tokens", () => {
    const tokens = Memory.tokenize("a b cd ef ghi")
    expect(tokens).not.toContain("a")
    expect(tokens).not.toContain("b")
    expect(tokens).toContain("cd")
    expect(tokens).toContain("ef")
    expect(tokens).toContain("ghi")
  })
})

describe("memory.bigrams", () => {
  test("generates character bigrams", () => {
    const bg = Memory.bigrams("hello")
    expect(bg.has("he")).toBe(true)
    expect(bg.has("el")).toBe(true)
    expect(bg.has("ll")).toBe(true)
    expect(bg.has("lo")).toBe(true)
    expect(bg.size).toBe(4)
  })

  test("bigramSimilarity returns 1 for identical strings", () => {
    const a = Memory.bigrams("hello world")
    const b = Memory.bigrams("hello world")
    expect(Memory.bigramSimilarity(a, b)).toBe(1)
  })

  test("bigramSimilarity returns 0 for completely different strings", () => {
    const a = Memory.bigrams("aaaa")
    const b = Memory.bigrams("zzzz")
    expect(Memory.bigramSimilarity(a, b)).toBe(0)
  })

  test("bigramSimilarity returns intermediate values", () => {
    const a = Memory.bigrams("hello")
    const b = Memory.bigrams("helly")
    const sim = Memory.bigramSimilarity(a, b)
    expect(sim).toBeGreaterThan(0)
    expect(sim).toBeLessThan(1)
  })
})

describe("memory.tokenSimilarity", () => {
  test("returns 1 for identical content", () => {
    expect(Memory.tokenSimilarity("hello world", "hello world")).toBe(1)
  })

  test("returns 0 for completely different content", () => {
    expect(Memory.tokenSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0)
  })

  test("returns partial match for overlapping content", () => {
    const sim = Memory.tokenSimilarity(
      "Uses NamedError for errors",
      "Uses NamedError for error handling",
    )
    expect(sim).toBeGreaterThan(0.5)
    expect(sim).toBeLessThan(1)
  })
})

describe("memory.extractCandidates", () => {
  test("extracts insights from think tool thoughts", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "think",
            state: {
              status: "completed",
              input: {
                thought: "This project always uses the Tool-define pattern for registering agent tools",
              },
            },
          },
        ],
      },
    ]

    const candidates = Memory.extractCandidates(messages)
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    expect(candidates[0].source).toBe("think")
    expect(candidates[0].content).toContain("Tool-define")
  })

  test("skips task-specific statements", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "think",
            state: {
              status: "completed",
              input: {
                thought: "I will always make sure to run the tests before committing",
              },
            },
          },
        ],
      },
    ]

    const candidates = Memory.extractCandidates(messages)
    // "I will" should be filtered out as task-specific
    expect(candidates).toHaveLength(0)
  })

  test("extracts from text parts with insight markers", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "text",
            content: "This project uses Drizzle ORM and always requires migration files for schema changes",
          },
        ],
      },
    ]

    const candidates = Memory.extractCandidates(messages)
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    expect(candidates[0].source).toBe("text")
  })

  test("deduplicates candidates", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "think",
            state: {
              status: "completed",
              input: { thought: "This codebase always uses NamedError for error types" },
            },
          },
          {
            type: "text",
            content: "This codebase always uses NamedError for error types",
          },
        ],
      },
    ]

    const candidates = Memory.extractCandidates(messages)
    // Same content from both sources should be deduplicated
    expect(candidates).toHaveLength(1)
  })

  test("infers memory type from content", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "text",
            content: "The timeout error always requires increasing the limit to 30 seconds",
          },
        ],
      },
    ]

    const candidates = Memory.extractCandidates(messages)
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    // Should infer "debugging" from "error" and "timeout"
    expect(candidates[0].type).toBe("debugging")
  })

  test("skips user messages", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [
          {
            type: "text",
            content: "This project always uses special conventions that must be followed",
          },
        ],
      },
    ]

    const candidates = Memory.extractCandidates(messages)
    expect(candidates).toHaveLength(0)
  })
})

describe("memory.consolidation", () => {
  test(
    "consolidates semantically similar memories",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Store two very similar memories manually (bypass dedup by making them different enough initially)
          const first = Memory.store("Uses Tool.define for all agent tools", "pattern")
          // Force insert a similar one by directly using db
          const { Database } = await import("../../src/storage/db")
          const { AgentMemoryTable } = await import("../../src/memory/schema.sql")
          const { ulid } = await import("ulid")
          const secondId = `mem_${ulid()}`
          Database.use((db: any) => {
            db.insert(AgentMemoryTable)
              .values({
                id: secondId,
                project_id: Instance.project.id,
                content: "Uses Tool.define for all the agent tools in project",
                type: "pattern",
                tags: [],
                time_created: Date.now(),
                time_updated: Date.now(),
                time_accessed: Date.now(),
                access_count: 0,
              })
              .run()
          })

          const before = Memory.list()
          expect(before).toHaveLength(2)

          const merged = Memory.consolidate()
          expect(merged).toBeGreaterThanOrEqual(1)

          const after = Memory.list()
          expect(after).toHaveLength(1)
        },
      })
    },
    30_000,
  )

  test(
    "does not consolidate different types",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Config has 7 levels", "architecture")
          // Force different type with similar content
          const { Database } = await import("../../src/storage/db")
          const { AgentMemoryTable } = await import("../../src/memory/schema.sql")
          const { ulid } = await import("ulid")
          Database.use((db: any) => {
            db.insert(AgentMemoryTable)
              .values({
                id: `mem_${ulid()}`,
                project_id: Instance.project.id,
                content: "Config has 7 levels of priority",
                type: "convention",
                tags: [],
                time_created: Date.now(),
                time_updated: Date.now(),
                time_accessed: Date.now(),
                access_count: 0,
              })
              .run()
          })

          const merged = Memory.consolidate()
          expect(merged).toBe(0) // Different types should not merge

          const all = Memory.list()
          expect(all).toHaveLength(2)
        },
      })
    },
    30_000,
  )
})

describe("memory.decay", () => {
  test(
    "decaying returns memories older than 30 days",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Store a memory and manually age it
          const entry = Memory.store("Old memory from long ago", "pattern")
          const { Database, eq } = await import("../../src/storage/db")
          const { AgentMemoryTable } = await import("../../src/memory/schema.sql")

          const oldTime = Date.now() - 35 * 24 * 60 * 60 * 1000 // 35 days ago
          Database.use((db: any) => {
            db.update(AgentMemoryTable)
              .set({ time_accessed: oldTime })
              .where(eq(AgentMemoryTable.id, entry.id))
              .run()
          })

          const stale = Memory.decaying()
          expect(stale).toHaveLength(1)
          expect(stale[0].id).toBe(entry.id)
        },
      })
    },
    30_000,
  )

  test(
    "prune removes very old memories",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const entry = Memory.store("Ancient memory", "debugging")
          const { Database, eq } = await import("../../src/storage/db")
          const { AgentMemoryTable } = await import("../../src/memory/schema.sql")

          const ancientTime = Date.now() - 100 * 24 * 60 * 60 * 1000 // 100 days ago
          Database.use((db: any) => {
            db.update(AgentMemoryTable)
              .set({ time_accessed: ancientTime })
              .where(eq(AgentMemoryTable.id, entry.id))
              .run()
          })

          const pruned = Memory.prune(90)
          expect(pruned).toBe(1)

          expect(Memory.get(entry.id)).toBeUndefined()
        },
      })
    },
    30_000,
  )

  test(
    "prune does not remove recent memories",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Recent memory", "pattern")
          const pruned = Memory.prune(90)
          expect(pruned).toBe(0)

          const all = Memory.list()
          expect(all).toHaveLength(1)
        },
      })
    },
    30_000,
  )
})

describe("memory.format with scoring", () => {
  test(
    "formats with relevance scoring when context provided",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses NamedError for error handling", "pattern", ["errors"])
          Memory.store("Config has 7 precedence levels", "architecture")
          Memory.store("WASM grammars need 30s timeout", "debugging")

          const block = Memory.format("error handling")
          expect(block).toBeDefined()
          expect(block).toContain("<agent-memory>")
          expect(block).toContain("NamedError")
        },
      })
    },
    30_000,
  )

  test(
    "format without context uses recency",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses Drizzle ORM for database access", "pattern")
          Memory.store("Config has 7 precedence levels", "architecture")

          const block = Memory.format()
          expect(block).toBeDefined()
          expect(block).toContain("Drizzle ORM")
          expect(block).toContain("precedence levels")
        },
      })
    },
    30_000,
  )

  test(
    "stats includes decaying count",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Fresh memory", "pattern")
          const s = Memory.stats()
          expect(s).toHaveProperty("decaying")
          expect(s.decaying).toBe(0)
        },
      })
    },
    30_000,
  )

  test(
    "store consolidates semantically similar on insert",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses Tool.define for agent tools", "pattern")
          // Very similar but not identical — should consolidate
          const second = Memory.store("Uses Tool.define for agent tools in this codebase", "pattern")

          const all = Memory.list()
          expect(all).toHaveLength(1)
          // The longer content should be kept
          expect(all[0].content).toContain("codebase")
        },
      })
    },
    30_000,
  )
})
