import { describe, expect, test } from "bun:test"
import { Packer } from "../../src/context/packer"
import type { Scorer } from "../../src/context/scorer"

describe("context.packer", () => {
  test("packs candidates within token budget", () => {
    const candidates: Scorer.ScoredCandidate[] = [
      {
        filePath: "src/auth.ts",
        name: "login",
        kind: "function",
        startLine: 1,
        endLine: 5,
        signature: "function login(user: string, pass: string): boolean",
        score: 0.9,
        signals: { nameMatch: 1, graphCentrality: 0.5, gitHotspot: 0.3, structuralProximity: 0, recency: 0 },
      },
      {
        filePath: "src/auth.ts",
        name: "logout",
        kind: "function",
        startLine: 7,
        endLine: 10,
        signature: "function logout(user: string): void",
        score: 0.5,
        signals: { nameMatch: 0.5, graphCentrality: 0.3, gitHotspot: 0.2, structuralProximity: 0, recency: 0 },
      },
    ]

    // Use a fake project ID — graph queries will return empty but shouldn't crash
    const packed = Packer.pack(candidates, "fake-project", {
      maxTokens: 2000,
      annotations: false,
      signatures: true,
    })

    // Should include at least signature entries
    expect(packed.entries.length).toBeGreaterThan(0)
    expect(packed.totalTokens).toBeGreaterThan(0)
    expect(packed.totalTokens).toBeLessThanOrEqual(2000)
    expect(packed.text).toContain("codebase-context")
  })

  test("respects token budget limit", () => {
    // Create many candidates that would exceed budget
    const candidates: Scorer.ScoredCandidate[] = Array.from({ length: 50 }, (_, i) => ({
      filePath: `src/module${i}.ts`,
      name: `function${i}`,
      kind: "function" as const,
      startLine: 1,
      endLine: 20,
      signature: `function function${i}(arg1: string, arg2: number, arg3: boolean): Promise<Result>`,
      score: 0.8 - i * 0.01,
      signals: { nameMatch: 0.8, graphCentrality: 0.5, gitHotspot: 0.3, structuralProximity: 0, recency: 0 },
    }))

    const packed = Packer.pack(candidates, "fake-project", {
      maxTokens: 500,
      annotations: false,
      signatures: true,
    })

    expect(packed.totalTokens).toBeLessThanOrEqual(500)
    expect(packed.dropped).toBeGreaterThan(0)
  })

  test("skips candidates with zero score", () => {
    const candidates: Scorer.ScoredCandidate[] = [
      {
        filePath: "src/zero.ts",
        name: "irrelevant",
        kind: "function",
        score: 0,
        signals: { nameMatch: 0, graphCentrality: 0, gitHotspot: 0, structuralProximity: 0, recency: 0 },
      },
    ]

    const packed = Packer.pack(candidates, "fake-project", { maxTokens: 2000, annotations: false, signatures: true })
    expect(packed.entries).toHaveLength(0)
  })

  test("returns empty text for empty candidates", () => {
    const packed = Packer.pack([], "fake-project", { maxTokens: 2000, annotations: false, signatures: true })
    expect(packed.entries).toHaveLength(0)
    expect(packed.text).toBe("")
    expect(packed.totalTokens).toBe(0)
  })

  test("formats output with file grouping", () => {
    const candidates: Scorer.ScoredCandidate[] = [
      {
        filePath: "src/auth.ts",
        name: "login",
        kind: "function",
        signature: "function login(): void",
        score: 0.9,
        signals: { nameMatch: 1, graphCentrality: 0, gitHotspot: 0, structuralProximity: 0, recency: 0 },
      },
      {
        filePath: "src/auth.ts",
        name: "logout",
        kind: "function",
        signature: "function logout(): void",
        score: 0.8,
        signals: { nameMatch: 0.8, graphCentrality: 0, gitHotspot: 0, structuralProximity: 0, recency: 0 },
      },
    ]

    const packed = Packer.pack(candidates, "fake-project", { maxTokens: 2000, annotations: false, signatures: true })
    expect(packed.text).toContain("// src/auth.ts")
    expect(packed.text).toContain("function login")
    expect(packed.text).toContain("function logout")
  })
})
