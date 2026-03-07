import { describe, expect, test } from "bun:test"
import { Token } from "../../src/util/token"
import { InjectionBudget } from "../../src/util/injection-budget"

describe("token.estimate", () => {
  test("estimates tokens at 4 chars per token", () => {
    expect(Token.estimate("hello world")).toBe(3) // 11 chars / 4 = 2.75 → 3
    expect(Token.estimate("")).toBe(0)
    expect(Token.estimate("abcd")).toBe(1) // 4 / 4 = 1
  })

  test("handles empty/null input", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("token.estimateForModel", () => {
  test("uses default ratio for unknown model", () => {
    const result = Token.estimateForModel("hello world", "gpt-4o")
    expect(result).toBe(3) // 11 / 4 = 2.75 → 3
  })

  test("uses Claude prose ratio for Claude models", () => {
    const text = "a".repeat(35) // 35 chars
    const result = Token.estimateForModel(text, "claude-opus-4-6", "prose")
    expect(result).toBe(10) // 35 / 3.5 = 10
  })

  test("uses Claude code ratio for code mode", () => {
    const text = "a".repeat(25) // 25 chars
    const result = Token.estimateForModel(text, "claude-sonnet-4-6", "code")
    expect(result).toBe(10) // 25 / 2.5 = 10
  })

  test("detects claude in model ID case-insensitively", () => {
    const text = "a".repeat(35)
    const upper = Token.estimateForModel(text, "Claude-Opus-4", "prose")
    const lower = Token.estimateForModel(text, "claude-opus-4", "prose")
    expect(upper).toBe(lower)
  })

  test("returns 0 for empty input", () => {
    expect(Token.estimateForModel("", "claude-opus-4")).toBe(0)
  })

  test("falls back to default without model ID", () => {
    const text = "a".repeat(40) // 40 chars
    expect(Token.estimateForModel(text)).toBe(10) // 40 / 4 = 10
  })
})

describe("injectionBudget.compute", () => {
  test("computes budgets for 200k context window", () => {
    const budget = InjectionBudget.compute(200_000)
    expect(budget.contextWindow).toBe(200_000)
    // 15% of 200k = 30k total tokens
    expect(budget.totalTokens).toBe(30_000)
    // Context: 40% of 30k = 12000 tokens
    expect(budget.contextTokens).toBe(12_000)
    // Memory: 25% of 30k = 7500 tokens * 4 chars = 30000 chars
    expect(budget.memoryChars).toBe(30_000)
    // Scratchpad: 25% of 30k = 7500 tokens * 4 chars = 30000 chars
    expect(budget.scratchpadChars).toBe(30_000)
  })

  test("computes budgets for 32k context window", () => {
    const budget = InjectionBudget.compute(32_000)
    expect(budget.totalTokens).toBe(4_800) // 15% of 32k
    expect(budget.scratchpadMaxThoughts).toBe(20) // 32k-128k range
    expect(budget.memoryMaxEntries).toBe(30) // medium window
  })

  test("scales thoughts down for small windows", () => {
    const budget = InjectionBudget.compute(16_000)
    expect(budget.scratchpadMaxThoughts).toBe(10)
    expect(budget.memoryMaxEntries).toBe(15)
  })

  test("scales up for large windows", () => {
    const budget = InjectionBudget.compute(200_000)
    expect(budget.scratchpadMaxThoughts).toBe(30)
    expect(budget.memoryMaxEntries).toBe(50)
  })

  test("redistributes budget when components unavailable", () => {
    const full = InjectionBudget.compute(128_000)
    const noMemory = InjectionBudget.compute(128_000, { memory: false })

    // Context should get more budget when memory is unavailable
    expect(noMemory.contextTokens).toBeGreaterThan(full.contextTokens)
    // Scratchpad should also get more
    expect(noMemory.scratchpadChars).toBeGreaterThan(full.scratchpadChars)
  })

  test("uses default 128k when no context window provided", () => {
    const budget = InjectionBudget.compute()
    expect(budget.contextWindow).toBe(128_000)
    expect(budget.totalTokens).toBe(19_200) // 15% of 128k
  })

  test("enforces minimum budget per component", () => {
    // Very small window
    const budget = InjectionBudget.compute(1_000)
    expect(budget.memoryChars).toBeGreaterThanOrEqual(1000)
    expect(budget.scratchpadChars).toBeGreaterThanOrEqual(1000)
    expect(budget.contextTokens).toBeGreaterThanOrEqual(250) // 1000/4
  })
})
