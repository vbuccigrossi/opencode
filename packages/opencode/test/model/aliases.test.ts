import { describe, it, expect } from "bun:test"
import { ModelAlias } from "../../src/model/aliases"

describe("model.aliases", () => {
  describe("defaults", () => {
    it("returns built-in aliases", () => {
      const defaults = ModelAlias.defaults()
      expect(defaults.fast).toBeDefined()
      expect(defaults.smart).toBeDefined()
      expect(defaults.code).toBeDefined()
      expect(defaults.cheap).toBeDefined()
      expect(defaults.balanced).toBeDefined()
    })

    it("fast maps to haiku", () => {
      const defaults = ModelAlias.defaults()
      expect(defaults.fast).toContain("haiku")
    })

    it("smart maps to opus", () => {
      const defaults = ModelAlias.defaults()
      expect(defaults.smart).toContain("opus")
    })

    it("code maps to sonnet", () => {
      const defaults = ModelAlias.defaults()
      expect(defaults.code).toContain("sonnet")
    })

    it("cheap maps to haiku", () => {
      const defaults = ModelAlias.defaults()
      expect(defaults.cheap).toContain("haiku")
    })

    it("all aliases have provider/model format", () => {
      const defaults = ModelAlias.defaults()
      for (const [alias, model] of Object.entries(defaults)) {
        expect(model).toContain("/")
      }
    })
  })

  describe("resolve", () => {
    it("resolves known aliases to model IDs", async () => {
      const resolved = await ModelAlias.resolve("fast")
      expect(resolved).toContain("haiku")
      expect(resolved).toContain("/")
    })

    it("resolves case-insensitively", async () => {
      const lower = await ModelAlias.resolve("fast")
      const upper = await ModelAlias.resolve("FAST")
      const mixed = await ModelAlias.resolve("Fast")
      expect(lower).toBe(upper)
      expect(lower).toBe(mixed)
    })

    it("trims whitespace", async () => {
      const trimmed = await ModelAlias.resolve("  fast  ")
      const plain = await ModelAlias.resolve("fast")
      expect(trimmed).toBe(plain)
    })

    it("returns unknown input as-is", async () => {
      const result = await ModelAlias.resolve("anthropic/claude-sonnet-4-6")
      expect(result).toBe("anthropic/claude-sonnet-4-6")
    })

    it("returns unknown alias as-is", async () => {
      const result = await ModelAlias.resolve("nonexistent-alias")
      expect(result).toBe("nonexistent-alias")
    })
  })

  describe("isAlias", () => {
    it("returns true for known aliases", async () => {
      expect(await ModelAlias.isAlias("fast")).toBe(true)
      expect(await ModelAlias.isAlias("smart")).toBe(true)
      expect(await ModelAlias.isAlias("code")).toBe(true)
    })

    it("returns false for unknown strings", async () => {
      expect(await ModelAlias.isAlias("anthropic/claude-sonnet-4-6")).toBe(false)
      expect(await ModelAlias.isAlias("unknown")).toBe(false)
    })

    it("is case-insensitive", async () => {
      expect(await ModelAlias.isAlias("FAST")).toBe(true)
      expect(await ModelAlias.isAlias("Smart")).toBe(true)
    })
  })

  describe("list", () => {
    it("returns all aliases", async () => {
      const all = await ModelAlias.list()
      expect(Object.keys(all).length).toBeGreaterThanOrEqual(10)
      expect(all.fast).toBeDefined()
      expect(all.smart).toBeDefined()
      expect(all.gpt).toBeDefined()
      expect(all.gemini).toBeDefined()
    })
  })
})
