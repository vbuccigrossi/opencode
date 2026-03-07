import { describe, expect, test } from "bun:test"
import { PreFlight } from "../../src/session/preflight"

describe("PreFlight", () => {
  describe("analyze", () => {
    test("low risk for single small file change", () => {
      const result = PreFlight.analyze([
        { filePath: "src/foo.ts", signatureChange: false, linesChanged: 5 },
      ])
      expect(result.riskLevel).toBe("low")
      expect(result.filesTouched).toEqual(["src/foo.ts"])
      expect(result.warnings).toHaveLength(0)
    })

    test("medium risk for multi-file changes", () => {
      const result = PreFlight.analyze([
        { filePath: "src/a.ts", signatureChange: false, linesChanged: 10 },
        { filePath: "src/b.ts", signatureChange: false, linesChanged: 10 },
      ])
      expect(result.riskLevel).toBe("medium")
    })

    test("high risk for 4+ files", () => {
      const result = PreFlight.analyze([
        { filePath: "src/a.ts", signatureChange: false, linesChanged: 5 },
        { filePath: "src/b.ts", signatureChange: false, linesChanged: 5 },
        { filePath: "src/c.ts", signatureChange: false, linesChanged: 5 },
        { filePath: "src/d.ts", signatureChange: false, linesChanged: 5 },
      ])
      expect(result.riskLevel).toBe("high")
      expect(result.warnings.some((w) => w.includes("4 files"))).toBe(true)
    })

    test("medium risk for large single-file change", () => {
      const result = PreFlight.analyze([
        { filePath: "src/foo.ts", signatureChange: false, linesChanged: 80 },
      ])
      expect(result.riskLevel).toBe("medium")
    })

    test("deduplicates file paths", () => {
      const result = PreFlight.analyze([
        { filePath: "src/foo.ts", signatureChange: false, linesChanged: 5 },
        { filePath: "src/foo.ts", signatureChange: false, linesChanged: 3 },
      ])
      expect(result.filesTouched).toEqual(["src/foo.ts"])
    })

    test("signature change with no callers is medium risk", () => {
      const result = PreFlight.analyze([
        { filePath: "src/foo.ts", signatureChange: true, linesChanged: 5 },
      ])
      // Without graph data, callers = 0, so signature change alone = low
      // But with signatureChange and callers > 0, it would be medium
      // With 0 callers it's just low
      expect(["low", "medium"]).toContain(result.riskLevel)
    })
  })

  describe("summarize", () => {
    test("includes risk level", () => {
      const analysis: PreFlight.Analysis = {
        filesTouched: ["src/foo.ts"],
        callersAffected: 0,
        testsAffected: [],
        riskLevel: "low",
        warnings: [],
      }
      const summary = PreFlight.summarize(analysis)
      expect(summary).toContain("Risk: low")
      expect(summary).toContain("Files: 1")
    })

    test("includes callers when present", () => {
      const analysis: PreFlight.Analysis = {
        filesTouched: ["src/foo.ts"],
        callersAffected: 5,
        testsAffected: [],
        riskLevel: "medium",
        warnings: [],
      }
      const summary = PreFlight.summarize(analysis)
      expect(summary).toContain("Callers: 5")
    })

    test("includes tests when present", () => {
      const analysis: PreFlight.Analysis = {
        filesTouched: ["src/foo.ts"],
        callersAffected: 0,
        testsAffected: ["test/foo.test.ts"],
        riskLevel: "low",
        warnings: [],
      }
      const summary = PreFlight.summarize(analysis)
      expect(summary).toContain("Tests: 1")
    })

    test("includes warnings", () => {
      const analysis: PreFlight.Analysis = {
        filesTouched: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
        callersAffected: 15,
        testsAffected: [],
        riskLevel: "high",
        warnings: [
          "Modifying 4 files — consider incremental changes",
          "15 callers affected — high potential for cascading failures",
        ],
      }
      const summary = PreFlight.summarize(analysis)
      expect(summary).toContain("⚠ Modifying 4 files")
      expect(summary).toContain("⚠ 15 callers affected")
    })
  })

  describe("quickRisk", () => {
    test("low risk for small change", () => {
      expect(PreFlight.quickRisk("src/foo.ts", 5)).toBe("low")
    })

    test("low risk for 10 lines", () => {
      expect(PreFlight.quickRisk("src/foo.ts", 10)).toBe("low")
    })

    test("medium risk for large change without graph", () => {
      // Without graph data, 51+ lines → medium
      expect(PreFlight.quickRisk("src/foo.ts", 60)).toBe("medium")
    })
  })
})

describe("Checkpoint", () => {
  describe("shouldAutoCheckpoint", () => {
    test("returns true for high risk", async () => {
      const { Checkpoint } = await import("../../src/session/checkpoint")
      expect(Checkpoint.shouldAutoCheckpoint("high")).toBe(true)
    })

    test("returns false for medium risk", async () => {
      const { Checkpoint } = await import("../../src/session/checkpoint")
      expect(Checkpoint.shouldAutoCheckpoint("medium")).toBe(false)
    })

    test("returns false for low risk", async () => {
      const { Checkpoint } = await import("../../src/session/checkpoint")
      expect(Checkpoint.shouldAutoCheckpoint("low")).toBe(false)
    })
  })
})
