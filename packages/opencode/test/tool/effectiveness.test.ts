import { describe, expect, test, beforeEach } from "bun:test"
import { ToolEffectiveness } from "../../src/tool/effectiveness"

const projectID = "test-project-123"

describe("ToolEffectiveness", () => {
  beforeEach(() => {
    ToolEffectiveness.clearAll()
  })

  describe("record", () => {
    test("records a tool use", () => {
      ToolEffectiveness.record(projectID, {
        tool: "grep",
        operation: "search",
        success: true,
        duration: 50,
        timestamp: Date.now(),
      })

      expect(ToolEffectiveness.recordCount(projectID)).toBe(1)
    })

    test("records multiple uses", () => {
      for (let i = 0; i < 10; i++) {
        ToolEffectiveness.record(projectID, {
          tool: "grep",
          success: i % 2 === 0,
          duration: 50 + i * 10,
          timestamp: Date.now(),
        })
      }

      expect(ToolEffectiveness.recordCount(projectID)).toBe(10)
    })

    test("caps records at max", () => {
      for (let i = 0; i < 600; i++) {
        ToolEffectiveness.record(projectID, {
          tool: "grep",
          success: true,
          duration: 50,
          timestamp: Date.now(),
        })
      }

      expect(ToolEffectiveness.recordCount(projectID)).toBeLessThanOrEqual(500)
    })

    test("never throws", () => {
      // Should silently succeed even with weird input
      expect(() => {
        ToolEffectiveness.record("", {
          tool: "",
          success: true,
          duration: 0,
          timestamp: 0,
        })
      }).not.toThrow()
    })
  })

  describe("stats", () => {
    test("returns zero stats for no records", () => {
      const s = ToolEffectiveness.stats(projectID, "grep")
      expect(s.uses).toBe(0)
      expect(s.successRate).toBe(0)
      expect(s.avgDuration).toBe(0)
    })

    test("computes success rate", () => {
      for (let i = 0; i < 10; i++) {
        ToolEffectiveness.record(projectID, {
          tool: "grep",
          success: i < 8, // 8 successes, 2 failures
          duration: 100,
          timestamp: Date.now(),
        })
      }

      const s = ToolEffectiveness.stats(projectID, "grep")
      expect(s.uses).toBe(10)
      expect(s.successRate).toBe(0.8)
      expect(s.successes).toBe(8)
      expect(s.failures).toBe(2)
    })

    test("computes average duration", () => {
      ToolEffectiveness.record(projectID, {
        tool: "read",
        success: true,
        duration: 100,
        timestamp: Date.now(),
      })
      ToolEffectiveness.record(projectID, {
        tool: "read",
        success: true,
        duration: 200,
        timestamp: Date.now(),
      })

      const s = ToolEffectiveness.stats(projectID, "read")
      expect(s.avgDuration).toBe(150)
    })

    test("filters by operation", () => {
      ToolEffectiveness.record(projectID, {
        tool: "graph",
        operation: "callers",
        success: true,
        duration: 200,
        timestamp: Date.now(),
      })
      ToolEffectiveness.record(projectID, {
        tool: "graph",
        operation: "impact",
        success: false,
        duration: 300,
        timestamp: Date.now(),
      })

      const callersStats = ToolEffectiveness.stats(projectID, "graph", "callers")
      expect(callersStats.uses).toBe(1)
      expect(callersStats.successRate).toBe(1)

      const impactStats = ToolEffectiveness.stats(projectID, "graph", "impact")
      expect(impactStats.uses).toBe(1)
      expect(impactStats.successRate).toBe(0)
    })
  })

  describe("allStats", () => {
    test("returns stats for all tools", () => {
      ToolEffectiveness.record(projectID, {
        tool: "grep",
        success: true,
        duration: 50,
        timestamp: Date.now(),
      })
      ToolEffectiveness.record(projectID, {
        tool: "graph",
        success: false,
        duration: 200,
        timestamp: Date.now(),
      })

      const all = ToolEffectiveness.allStats(projectID)
      expect(all.size).toBe(2)
      expect(all.get("grep")!.uses).toBe(1)
      expect(all.get("graph")!.uses).toBe(1)
    })
  })

  describe("recommend", () => {
    test("returns undefined with insufficient data", () => {
      ToolEffectiveness.record(projectID, {
        tool: "grep",
        operation: "search",
        success: true,
        duration: 50,
        timestamp: Date.now(),
      })

      const rec = ToolEffectiveness.recommend(projectID, "search")
      expect(rec).toBeUndefined() // Not enough uses
    })

    test("recommends most effective tool after enough uses", () => {
      // Grep: 90% success, fast
      for (let i = 0; i < 10; i++) {
        ToolEffectiveness.record(projectID, {
          tool: "grep",
          operation: "search",
          success: i < 9,
          duration: 50,
          timestamp: Date.now(),
        })
      }

      // Graph: 50% success, slow
      for (let i = 0; i < 10; i++) {
        ToolEffectiveness.record(projectID, {
          tool: "graph",
          operation: "search",
          success: i < 5,
          duration: 500,
          timestamp: Date.now(),
        })
      }

      const rec = ToolEffectiveness.recommend(projectID, "search")
      expect(rec).toBe("grep")
    })

    test("returns undefined for unknown operation", () => {
      const rec = ToolEffectiveness.recommend(projectID, "nonexistent")
      expect(rec).toBeUndefined()
    })
  })

  describe("format", () => {
    test("returns empty for no data", () => {
      expect(ToolEffectiveness.format(projectID)).toBe("")
    })

    test("returns empty for insufficient data", () => {
      ToolEffectiveness.record(projectID, {
        tool: "grep",
        success: true,
        duration: 50,
        timestamp: Date.now(),
      })

      expect(ToolEffectiveness.format(projectID)).toBe("")
    })

    test("formats hints after enough uses", () => {
      for (let i = 0; i < 10; i++) {
        ToolEffectiveness.record(projectID, {
          tool: "grep",
          success: i < 9,
          duration: 50,
          timestamp: Date.now(),
        })
      }

      const formatted = ToolEffectiveness.format(projectID)
      expect(formatted).toContain("<tool-hints>")
      expect(formatted).toContain("</tool-hints>")
      expect(formatted).toContain("grep")
      expect(formatted).toContain("90%")
    })

    test("includes multiple tools", () => {
      for (let i = 0; i < 8; i++) {
        ToolEffectiveness.record(projectID, {
          tool: "grep",
          success: true,
          duration: 50,
          timestamp: Date.now(),
        })
        ToolEffectiveness.record(projectID, {
          tool: "graph",
          success: i < 6,
          duration: 200,
          timestamp: Date.now(),
        })
      }

      const formatted = ToolEffectiveness.format(projectID)
      expect(formatted).toContain("grep")
      expect(formatted).toContain("graph")
    })
  })

  describe("clear", () => {
    test("clears project records", () => {
      ToolEffectiveness.record(projectID, {
        tool: "grep",
        success: true,
        duration: 50,
        timestamp: Date.now(),
      })

      expect(ToolEffectiveness.recordCount(projectID)).toBe(1)
      ToolEffectiveness.clear(projectID)
      expect(ToolEffectiveness.recordCount(projectID)).toBe(0)
    })
  })
})
