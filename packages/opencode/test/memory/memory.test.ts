import { describe, expect, test } from "bun:test"
import { Memory } from "../../src/memory"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("memory", () => {
  test(
    "stores and retrieves a memory",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const entry = Memory.store(
            "This project uses Tool.define() for all agent tools",
            "pattern",
            ["tools"],
          )

          expect(entry.id).toStartWith("mem_")
          expect(entry.content).toBe("This project uses Tool.define() for all agent tools")
          expect(entry.type).toBe("pattern")
          expect(entry.tags).toEqual(["tools"])
          expect(entry.accessCount).toBe(0)

          // Retrieve by ID
          const retrieved = Memory.get(entry.id)
          expect(retrieved).toBeDefined()
          expect(retrieved!.content).toBe(entry.content)
        },
      })
    },
    30_000,
  )

  test(
    "deduplicates identical memories",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const first = Memory.store("Bun is the package manager", "convention")
          const second = Memory.store("Bun is the package manager", "convention")

          // Should return the same entry (updated, not duplicated)
          expect(first.id).toBe(second.id)

          // Only one memory should exist
          const all = Memory.list()
          const matching = all.filter((m) => m.content === "Bun is the package manager")
          expect(matching).toHaveLength(1)
        },
      })
    },
    30_000,
  )

  test(
    "lists memories filtered by type",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses Tool.define for registering agent tools", "pattern")
          Memory.store("Config module has 7 precedence levels", "architecture")
          Memory.store("Drizzle ORM handles all database queries", "pattern")

          const patterns = Memory.list("pattern")
          expect(patterns).toHaveLength(2)
          expect(patterns.every((m) => m.type === "pattern")).toBe(true)

          const arch = Memory.list("architecture")
          expect(arch).toHaveLength(1)

          const all = Memory.list()
          expect(all).toHaveLength(3)
        },
      })
    },
    30_000,
  )

  test(
    "searches memories by content",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses NamedError for error handling", "pattern")
          Memory.store("Config has 7 precedence levels", "architecture")
          Memory.store("WASM grammars need 30s timeout", "debugging")

          const results = Memory.search("error")
          expect(results).toHaveLength(1)
          expect(results[0].content).toContain("NamedError")

          const configResults = Memory.search("Config")
          expect(configResults).toHaveLength(1)
        },
      })
    },
    30_000,
  )

  test(
    "forgets a memory",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const entry = Memory.store("Temporary memory", "debugging")
          expect(Memory.get(entry.id)).toBeDefined()

          const deleted = Memory.forget(entry.id)
          expect(deleted).toBe(true)
          expect(Memory.get(entry.id)).toBeUndefined()

          // Forget non-existent returns false
          const again = Memory.forget(entry.id)
          expect(again).toBe(false)
        },
      })
    },
    30_000,
  )

  test(
    "updates a memory",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const entry = Memory.store("Old content", "pattern")
          const updated = Memory.update(entry.id, "New content")
          expect(updated.content).toBe("New content")
          expect(updated.id).toBe(entry.id)
          expect(updated.timeUpdated).toBeGreaterThanOrEqual(entry.timeUpdated)
        },
      })
    },
    30_000,
  )

  test(
    "formats memory block for system prompt",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("Uses Tool.define() pattern", "pattern", ["tools"])
          Memory.store("Config uses Zod schemas", "architecture")
          Memory.store("Build needs bun run typecheck", "convention")

          const block = Memory.format()
          expect(block).toBeDefined()
          expect(block).toContain("<agent-memory>")
          expect(block).toContain("</agent-memory>")
          expect(block).toContain("Tool.define()")
          expect(block).toContain("Zod schemas")
          expect(block).toContain("bun run typecheck")
          expect(block).toContain("Patterns & Conventions")
        },
      })
    },
    30_000,
  )

  test(
    "returns undefined format when no memories",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(Memory.format()).toBeUndefined()
        },
      })
    },
    30_000,
  )

  test(
    "returns stats",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Memory.store("A pattern", "pattern")
          Memory.store("A debugging note", "debugging")
          Memory.store("Another pattern", "pattern")

          const s = Memory.stats()
          expect(s.total).toBe(3)
          expect(s.byType.pattern).toBe(2)
          expect(s.byType.debugging).toBe(1)
        },
      })
    },
    30_000,
  )
})
