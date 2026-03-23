import { describe, it, expect } from "bun:test"
import { Ollama } from "../../src/provider/ollama"

/**
 * Tests for ollama provider auto-detection.
 *
 * These tests verify the ollama module's behavior without requiring
 * an actual ollama instance to be running. Network-dependent tests
 * are skipped when ollama is not available.
 */

describe("Ollama", () => {
  it("isRunning returns a boolean", async () => {
    const result = await Ollama.isRunning()
    expect(typeof result).toBe("boolean")
  })

  it("isRunning returns false for unreachable host", async () => {
    const result = await Ollama.isRunning("http://localhost:99999")
    expect(result).toBe(false)
  })

  it("listModels returns an array", async () => {
    const models = await Ollama.listModels()
    expect(Array.isArray(models)).toBe(true)
  })

  it("listModels returns empty for unreachable host", async () => {
    const models = await Ollama.listModels("http://localhost:99999")
    expect(models).toEqual([])
  })

  it("getModels returns an array", async () => {
    const models = await Ollama.getModels()
    expect(Array.isArray(models)).toBe(true)
  })

  it("getModels returns empty for unreachable host", async () => {
    const models = await Ollama.getModels("http://localhost:99999")
    expect(models).toEqual([])
  })

  it("buildProviderConfig returns undefined for unreachable host", async () => {
    const config = await Ollama.buildProviderConfig("http://localhost:99999")
    expect(config).toBeUndefined()
  })

  it("buildProviderConfig returns valid config shape when ollama is running", async () => {
    const running = await Ollama.isRunning()
    if (!running) return // skip if ollama not available

    const config = await Ollama.buildProviderConfig()
    if (!config) return // no non-embedding models

    expect(config.name).toBe("Ollama (Local)")
    expect(config.api).toContain("/v1")
    expect(config.npm).toBe("@ai-sdk/openai-compatible")
    expect(typeof config.models).toBe("object")
    expect(Object.keys(config.models).length).toBeGreaterThan(0)

    for (const model of Object.values(config.models)) {
      expect(model.name).toBeTruthy()
      expect(model.id).toBeTruthy()
      expect(typeof model.temperature).toBe("boolean")
      expect(typeof model.tool_call).toBe("boolean")
    }
  })

  it("buildProviderConfig excludes embedding models", async () => {
    const running = await Ollama.isRunning()
    if (!running) return

    const config = await Ollama.buildProviderConfig()
    if (!config) return

    for (const name of Object.keys(config.models)) {
      expect(name).not.toContain("embed")
      expect(name).not.toContain("nomic")
    }
  })
})
