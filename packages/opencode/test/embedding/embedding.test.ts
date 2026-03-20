import { describe, it, expect } from "bun:test"
import { EmbeddingStore } from "../../src/embedding/store"
import { EmbeddingProvider } from "../../src/embedding/provider"
import { EmbeddingIndexer } from "../../src/embedding/indexer"

describe("embedding", () => {
  describe("EmbeddingStore.serialize/deserialize", () => {
    it("round-trips a Float32Array through Buffer", () => {
      const original = new Float32Array([0.1, 0.2, 0.3, -0.5, 1.0])
      const buf = EmbeddingStore.serialize(original)
      const restored = EmbeddingStore.deserialize(buf)

      expect(restored.length).toBe(original.length)
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 5)
      }
    })

    it("handles empty vector", () => {
      const original = new Float32Array([])
      const buf = EmbeddingStore.serialize(original)
      const restored = EmbeddingStore.deserialize(buf)
      expect(restored.length).toBe(0)
    })

    it("handles large vector", () => {
      const size = 768
      const original = new Float32Array(size)
      for (let i = 0; i < size; i++) {
        original[i] = Math.random() * 2 - 1
      }
      const buf = EmbeddingStore.serialize(original)
      const restored = EmbeddingStore.deserialize(buf)
      expect(restored.length).toBe(size)
      for (let i = 0; i < size; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 5)
      }
    })
  })

  describe("EmbeddingStore.cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const a = new Float32Array([1, 2, 3])
      const b = new Float32Array([1, 2, 3])
      expect(EmbeddingStore.cosineSimilarity(a, b)).toBeCloseTo(1.0, 5)
    })

    it("returns -1 for opposite vectors", () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([-1, 0, 0])
      expect(EmbeddingStore.cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5)
    })

    it("returns 0 for orthogonal vectors", () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([0, 1, 0])
      expect(EmbeddingStore.cosineSimilarity(a, b)).toBeCloseTo(0.0, 5)
    })

    it("handles scaled versions of same direction", () => {
      const a = new Float32Array([1, 2, 3])
      const b = new Float32Array([2, 4, 6])
      expect(EmbeddingStore.cosineSimilarity(a, b)).toBeCloseTo(1.0, 5)
    })

    it("computes correctly for non-trivial vectors", () => {
      const a = new Float32Array([1, 2, 3])
      const b = new Float32Array([4, 5, 6])
      // dot = 4+10+18 = 32
      // normA = sqrt(1+4+9) = sqrt(14)
      // normB = sqrt(16+25+36) = sqrt(77)
      // cos = 32 / (sqrt(14)*sqrt(77))
      const expected = 32 / (Math.sqrt(14) * Math.sqrt(77))
      expect(EmbeddingStore.cosineSimilarity(a, b)).toBeCloseTo(expected, 5)
    })

    it("returns 0 for zero vector", () => {
      const a = new Float32Array([0, 0, 0])
      const b = new Float32Array([1, 2, 3])
      expect(EmbeddingStore.cosineSimilarity(a, b)).toBe(0)
    })

    it("throws on dimension mismatch", () => {
      const a = new Float32Array([1, 2])
      const b = new Float32Array([1, 2, 3])
      expect(() => EmbeddingStore.cosineSimilarity(a, b)).toThrow("dimension mismatch")
    })
  })

  describe("EmbeddingProvider.getConfig", () => {
    it("returns defaults when no config is set", async () => {
      const config = await EmbeddingProvider.getConfig()
      expect(config.baseURL).toBe("http://localhost:11434/v1")
      expect(config.model).toBe("nomic-embed-text")
      expect(config.batchSize).toBe(32)
      expect(config.timeout).toBe(30_000)
    })
  })

  describe("EmbeddingProvider.resetCache", () => {
    it("resets the cached dimension", () => {
      // Just verify it doesn't throw
      EmbeddingProvider.resetCache()
    })
  })

  describe("EmbeddingIndexer.buildEmbeddingText", () => {
    it("builds text with file path, kind, and name", () => {
      const text = EmbeddingIndexer.buildEmbeddingText(
        {
          name: "processRequest",
          kind: "function",
          file_path: "/project/src/handler.ts",
          signature: "function processRequest(req: Request): Response",
          start_line: 10,
          end_line: 25,
        },
        "/project",
      )

      expect(text).toContain("File: src/handler.ts")
      expect(text).toContain("Kind: function")
      expect(text).toContain("Name: processRequest")
      expect(text).toContain("Signature: function processRequest(req: Request): Response")
    })

    it("handles missing signature", () => {
      const text = EmbeddingIndexer.buildEmbeddingText(
        {
          name: "MyClass",
          kind: "class",
          file_path: "/project/src/model.ts",
          signature: null,
          start_line: 1,
          end_line: 50,
        },
        "/project",
      )

      expect(text).toContain("File: src/model.ts")
      expect(text).toContain("Kind: class")
      expect(text).toContain("Name: MyClass")
      expect(text).not.toContain("Signature:")
    })

    it("computes relative file path", () => {
      const text = EmbeddingIndexer.buildEmbeddingText(
        {
          name: "helper",
          kind: "function",
          file_path: "/home/user/project/src/utils/helpers.ts",
          signature: null,
          start_line: 1,
          end_line: 5,
        },
        "/home/user/project",
      )

      expect(text).toContain("File: src/utils/helpers.ts")
    })
  })
})
