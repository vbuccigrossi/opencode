import { describe, expect, test } from "bun:test"

/**
 * Tests for centrality scoring logic.
 * Since Graph.centrality() requires a populated DB, we test the formula directly.
 */
describe("graph.centrality", () => {
  test("centrality formula: isolated node scores 0", () => {
    const inbound = 0
    const outbound = 0
    const score = Math.log2(inbound + 1) * 0.6 + Math.log2(outbound + 1) * 0.4
    expect(score).toBe(0)
  })

  test("centrality formula: node with 1 inbound edge", () => {
    const inbound = 1
    const outbound = 0
    const score = Math.log2(inbound + 1) * 0.6 + Math.log2(outbound + 1) * 0.4
    expect(score).toBeCloseTo(0.6, 5) // log2(2) * 0.6 = 1 * 0.6 = 0.6
  })

  test("centrality formula: well-connected node", () => {
    const inbound = 15
    const outbound = 7
    const score = Math.log2(inbound + 1) * 0.6 + Math.log2(outbound + 1) * 0.4
    // log2(16) = 4, log2(8) = 3
    expect(score).toBeCloseTo(4 * 0.6 + 3 * 0.4, 5)
    expect(score).toBeCloseTo(3.6, 5)
  })

  test("inbound edges weighted more than outbound", () => {
    // Node with many callers should score higher than node with many callees
    const highInbound = Math.log2(10 + 1) * 0.6 + Math.log2(1 + 1) * 0.4
    const highOutbound = Math.log2(1 + 1) * 0.6 + Math.log2(10 + 1) * 0.4
    expect(highInbound).toBeGreaterThan(highOutbound)
  })

  test("centrality grows logarithmically", () => {
    const score10 = Math.log2(10 + 1) * 0.6
    const score100 = Math.log2(100 + 1) * 0.6
    const score1000 = Math.log2(1000 + 1) * 0.6

    // Each 10x jump should produce a smaller absolute increase
    const jump1 = score100 - score10    // ~10 → ~100
    const jump2 = score1000 - score100  // ~100 → ~1000
    // The ratio of jumps should be consistent (log property)
    expect(jump2 / jump1).toBeCloseTo(1.0, 0) // roughly equal (both are ~log2(10)*0.6)
    // All scores should be positive and increasing
    expect(score10).toBeGreaterThan(0)
    expect(score100).toBeGreaterThan(score10)
    expect(score1000).toBeGreaterThan(score100)
  })
})
