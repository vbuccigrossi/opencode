import { describe, expect, test, beforeEach } from "bun:test"
import { Tuning } from "../../src/tuning"
import { TuningRules } from "../../src/tuning/rules"

describe("TuningRules", () => {
  describe("detectSearchPivot", () => {
    test("triggers after 3+ failed greps", () => {
      const history: TuningRules.ToolRecord[] = Array.from({ length: 4 }, () => ({
        tool: "grep",
        success: false,
        timestamp: Date.now(),
      }))
      const adjustments = TuningRules.analyze(history)
      const pivot = adjustments.find((a) => a.type === "try_alternative")
      expect(pivot).toBeDefined()
      expect(pivot!.reason).toContain("grep failed")
    })

    test("does not trigger with fewer than 3 failed greps", () => {
      const history: TuningRules.ToolRecord[] = [
        { tool: "grep", success: false, timestamp: Date.now() },
        { tool: "grep", success: false, timestamp: Date.now() },
      ]
      const adjustments = TuningRules.analyze(history)
      const pivot = adjustments.find((a) => a.type === "try_alternative" && a.tool === "grep")
      expect(pivot).toBeUndefined()
    })
  })

  describe("detectVerificationSpiral", () => {
    test("triggers after 3+ consecutive verify failures", () => {
      const history: TuningRules.ToolRecord[] = Array.from({ length: 3 }, () => ({
        tool: "verify",
        success: false,
        timestamp: Date.now(),
      }))
      const adjustments = TuningRules.analyze(history)
      const spiral = adjustments.find((a) => a.type === "think_more")
      expect(spiral).toBeDefined()
      expect(spiral!.reason).toContain("verification failures")
    })

    test("resets on successful verify", () => {
      const history: TuningRules.ToolRecord[] = [
        { tool: "verify", success: false, timestamp: Date.now() },
        { tool: "verify", success: true, timestamp: Date.now() },
        { tool: "verify", success: false, timestamp: Date.now() },
        { tool: "verify", success: false, timestamp: Date.now() },
      ]
      const adjustments = TuningRules.analyze(history)
      const spiral = adjustments.find((a) => a.type === "think_more")
      expect(spiral).toBeUndefined()
    })
  })

  describe("detectReadFatigue", () => {
    test("triggers after 5+ reads without an edit", () => {
      const history: TuningRules.ToolRecord[] = [
        { tool: "read", success: true, timestamp: Date.now() },
        { tool: "grep", success: true, timestamp: Date.now() },
        { tool: "read", success: true, timestamp: Date.now() },
        { tool: "glob", success: true, timestamp: Date.now() },
        { tool: "read", success: true, timestamp: Date.now() },
      ]
      const adjustments = TuningRules.analyze(history)
      const fatigue = adjustments.find((a) => a.type === "slow_down")
      expect(fatigue).toBeDefined()
      expect(fatigue!.reason).toContain("research operations")
    })

    test("resets on edit", () => {
      const history: TuningRules.ToolRecord[] = [
        { tool: "read", success: true, timestamp: Date.now() },
        { tool: "read", success: true, timestamp: Date.now() },
        { tool: "edit", success: true, timestamp: Date.now() },
        { tool: "read", success: true, timestamp: Date.now() },
        { tool: "read", success: true, timestamp: Date.now() },
      ]
      const adjustments = TuningRules.analyze(history)
      const fatigue = adjustments.find((a) => a.type === "slow_down")
      expect(fatigue).toBeUndefined()
    })
  })

  describe("detectRepeatedFailure", () => {
    test("triggers for tool with 3+ failures", () => {
      const history: TuningRules.ToolRecord[] = [
        { tool: "bash", success: false, timestamp: Date.now() },
        { tool: "bash", success: false, timestamp: Date.now() },
        { tool: "bash", success: false, timestamp: Date.now() },
        { tool: "read", success: true, timestamp: Date.now() },
      ]
      const adjustments = TuningRules.analyze(history)
      const avoid = adjustments.find((a) => a.type === "avoid_tool" && a.tool === "bash")
      expect(avoid).toBeDefined()
    })
  })

  describe("detectToolPreference", () => {
    test("triggers for tools with low success rate", () => {
      const history: TuningRules.ToolRecord[] = []
      for (let i = 0; i < 10; i++) {
        history.push({
          tool: "flaky_tool",
          success: i < 2, // 20% success rate
          timestamp: Date.now(),
        })
      }
      const adjustments = TuningRules.analyze(history)
      const avoid = adjustments.find((a) => a.type === "avoid_tool" && a.tool === "flaky_tool")
      expect(avoid).toBeDefined()
      expect(avoid!.reason).toContain("flaky_tool")
    })

    test("does not trigger for small sample sizes", () => {
      const history: TuningRules.ToolRecord[] = [
        { tool: "new_tool", success: false, timestamp: Date.now() },
        { tool: "new_tool", success: false, timestamp: Date.now() },
      ]
      const adjustments = TuningRules.analyze(history)
      const pref = adjustments.find((a) => a.type === "avoid_tool" && a.reason.includes("success rate") && a.tool === "new_tool")
      expect(pref).toBeUndefined()
    })
  })

  test("sorts adjustments by priority", () => {
    const history: TuningRules.ToolRecord[] = [
      // Read fatigue (priority 0.6)
      ...Array.from({ length: 6 }, () => ({
        tool: "read" as const,
        success: true,
        timestamp: Date.now(),
      })),
    ]
    // Add grep failures (priority 0.8)
    for (let i = 0; i < 4; i++) {
      history.push({ tool: "grep", success: false, timestamp: Date.now() })
    }

    const adjustments = TuningRules.analyze(history)
    if (adjustments.length >= 2) {
      expect(adjustments[0].priority).toBeGreaterThanOrEqual(adjustments[1].priority)
    }
  })
})

describe("Tuning", () => {
  const sessionId = "test-session"

  beforeEach(() => {
    Tuning.clearAll()
  })

  test("recordResult and historyLength", () => {
    expect(Tuning.historyLength(sessionId)).toBe(0)
    Tuning.recordResult(sessionId, "read", true)
    Tuning.recordResult(sessionId, "edit", true)
    expect(Tuning.historyLength(sessionId)).toBe(2)
  })

  test("analyze returns empty for fresh session", () => {
    const adjustments = Tuning.analyze(sessionId)
    expect(adjustments).toEqual([])
  })

  test("analyze detects patterns", () => {
    for (let i = 0; i < 4; i++) {
      Tuning.recordResult(sessionId, "grep", false)
    }
    const adjustments = Tuning.analyze(sessionId)
    expect(adjustments.length).toBeGreaterThan(0)
  })

  test("format returns empty string when no adjustments", () => {
    const output = Tuning.format(sessionId)
    expect(output).toBe("")
  })

  test("format returns tuning block when adjustments exist", () => {
    for (let i = 0; i < 4; i++) {
      Tuning.recordResult(sessionId, "grep", false)
    }
    const output = Tuning.format(sessionId)
    expect(output).toContain("<tuning>")
    expect(output).toContain("</tuning>")
  })

  test("clear removes session state", () => {
    Tuning.recordResult(sessionId, "read", true)
    Tuning.clear(sessionId)
    expect(Tuning.historyLength(sessionId)).toBe(0)
  })

  test("caps history at MAX_HISTORY", () => {
    for (let i = 0; i < 120; i++) {
      Tuning.recordResult(sessionId, "read", true)
    }
    expect(Tuning.historyLength(sessionId)).toBeLessThanOrEqual(100)
  })

  test("active returns cached adjustments", () => {
    expect(Tuning.active(sessionId)).toEqual([])
    for (let i = 0; i < 4; i++) {
      Tuning.recordResult(sessionId, "grep", false)
    }
    Tuning.analyze(sessionId)
    expect(Tuning.active(sessionId).length).toBeGreaterThan(0)
  })
})
