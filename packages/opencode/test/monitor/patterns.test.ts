import { describe, expect, test, beforeEach } from "bun:test"
import { MonitorPatterns } from "../../src/monitor/patterns"
import { MonitorSignals } from "../../src/monitor/signals"
import { Monitor } from "../../src/monitor"

// ---------------------------------------------------------------------------
// Pattern detection tests
// ---------------------------------------------------------------------------

describe("MonitorPatterns", () => {
  describe("detectCircularEdits", () => {
    test("no warnings when below threshold", () => {
      const edits = new Map([["src/foo.ts", 2]])
      const warnings = MonitorPatterns.detectCircularEdits(edits, 3)
      expect(warnings).toHaveLength(0)
    })

    test("warns at threshold", () => {
      const edits = new Map([["src/foo.ts", 3]])
      const warnings = MonitorPatterns.detectCircularEdits(edits, 3)
      expect(warnings).toHaveLength(1)
      expect(warnings[0].signal).toBe("circular_edits")
      expect(warnings[0].severity).toBe("warn")
      expect(warnings[0].message).toContain("foo.ts")
      expect(warnings[0].message).toContain("3 times")
    })

    test("critical severity when well above threshold", () => {
      const edits = new Map([["src/foo.ts", 5]])
      const warnings = MonitorPatterns.detectCircularEdits(edits, 3)
      expect(warnings[0].severity).toBe("critical")
    })

    test("warns for multiple files independently", () => {
      const edits = new Map([
        ["src/a.ts", 3],
        ["src/b.ts", 4],
        ["src/c.ts", 1],
      ])
      const warnings = MonitorPatterns.detectCircularEdits(edits, 3)
      expect(warnings).toHaveLength(2)
    })
  })

  describe("detectRedundantReads", () => {
    test("no warnings below threshold", () => {
      const reads = new Map([["src/foo.ts", 2]])
      const warnings = MonitorPatterns.detectRedundantReads(reads, new Set(), 3)
      expect(warnings).toHaveLength(0)
    })

    test("warns for files read many times", () => {
      const reads = new Map([["src/foo.ts", 4]])
      const warnings = MonitorPatterns.detectRedundantReads(reads, new Set(), 3)
      expect(warnings).toHaveLength(1)
      expect(warnings[0].signal).toBe("redundant_reads")
    })

    test("skips files that have been edited (re-reads are expected)", () => {
      const reads = new Map([["src/foo.ts", 5]])
      const edited = new Set(["src/foo.ts"])
      const warnings = MonitorPatterns.detectRedundantReads(reads, edited, 3)
      expect(warnings).toHaveLength(0)
    })
  })

  describe("detectVerificationSpiral", () => {
    test("no warning below threshold", () => {
      const warning = MonitorPatterns.detectVerificationSpiral(2, 3)
      expect(warning).toBeUndefined()
    })

    test("warns at threshold", () => {
      const warning = MonitorPatterns.detectVerificationSpiral(3, 3)
      expect(warning).toBeDefined()
      expect(warning!.signal).toBe("verification_spiral")
      expect(warning!.severity).toBe("warn")
    })

    test("critical severity well above threshold", () => {
      const warning = MonitorPatterns.detectVerificationSpiral(5, 3)
      expect(warning!.severity).toBe("critical")
    })

    test("includes checkpoint hint when available", () => {
      const warning = MonitorPatterns.detectVerificationSpiral(3, 3, "abc123")
      expect(warning!.message).toContain("abc123")
      expect(warning!.message).toContain("rolling back")
    })

    test("no checkpoint hint when not available", () => {
      const warning = MonitorPatterns.detectVerificationSpiral(3, 3)
      expect(warning!.message).not.toContain("rolling back")
    })
  })

  describe("detectContextBurn", () => {
    test("no warning at normal usage", () => {
      const warning = MonitorPatterns.detectContextBurn(0.3, 3, 0.5, 0.8)
      expect(warning).toBeUndefined()
    })

    test("warns for early high usage", () => {
      const warning = MonitorPatterns.detectContextBurn(0.55, 4, 0.5, 0.8)
      expect(warning).toBeDefined()
      expect(warning!.signal).toBe("context_burn")
      expect(warning!.severity).toBe("warn")
    })

    test("does not warn for high usage at later steps (expected)", () => {
      const warning = MonitorPatterns.detectContextBurn(0.6, 15, 0.5, 0.8)
      expect(warning).toBeUndefined()
    })

    test("critical at critical threshold", () => {
      const warning = MonitorPatterns.detectContextBurn(0.85, 10, 0.5, 0.8)
      expect(warning).toBeDefined()
      expect(warning!.severity).toBe("critical")
      expect(warning!.message).toContain("85%")
    })
  })

  describe("detectGoalDrift", () => {
    test("no warning with insufficient data", () => {
      const recent = [{ tool: "read", files: ["src/foo.ts"] }]
      const warning = MonitorPatterns.detectGoalDrift(recent, ["auth"], new Set(), 4, "Fix auth")
      expect(warning).toBeUndefined()
    })

    test("no warning when tools are related to goal", () => {
      const recent = [
        { tool: "read", files: ["src/auth.ts"] },
        { tool: "edit", files: ["src/auth.ts"] },
        { tool: "read", files: ["src/auth-utils.ts"] },
        { tool: "edit", files: ["src/auth-utils.ts"] },
      ]
      const warning = MonitorPatterns.detectGoalDrift(recent, ["auth"], new Set(["src/auth.ts"]), 4, "Fix auth")
      expect(warning).toBeUndefined()
    })

    test("warns when tools are unrelated to goal", () => {
      const recent = [
        { tool: "read", files: ["src/theme.ts"] },
        { tool: "edit", files: ["src/css.ts"] },
        { tool: "read", files: ["src/icons.ts"] },
        { tool: "edit", files: ["src/layout.ts"] },
      ]
      const warning = MonitorPatterns.detectGoalDrift(recent, ["auth", "login"], new Set(), 4, "Fix auth login flow")
      expect(warning).toBeDefined()
      expect(warning!.signal).toBe("goal_drift")
      expect(warning!.message).toContain("Fix auth login flow")
    })

    test("no warning when no goal keywords", () => {
      const recent = Array(5).fill({ tool: "read", files: ["unrelated.ts"] })
      const warning = MonitorPatterns.detectGoalDrift(recent, [], new Set(), 4, "")
      expect(warning).toBeUndefined()
    })
  })

  describe("detectUnproductiveReads", () => {
    test("no warning below threshold", () => {
      const reads = new Set(["a.ts", "b.ts", "c.ts"])
      const edits = new Set(["a.ts"])
      const warning = MonitorPatterns.detectUnproductiveReads(reads, edits, new Set(), 8)
      expect(warning).toBeUndefined()
    })

    test("warns when many files read but unused", () => {
      const reads = new Set(Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`))
      const edits = new Set(["src/file0.ts", "src/file1.ts"])
      const warning = MonitorPatterns.detectUnproductiveReads(reads, edits, new Set(), 8)
      expect(warning).toBeDefined()
      expect(warning!.signal).toBe("unproductive_reads")
      expect(warning!.message).toContain("8 files")
    })

    test("counts files referenced in edits as productive", () => {
      const reads = new Set(Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`))
      const edits = new Set(["src/file0.ts"])
      // Mark most files as referenced in edits
      const referenced = new Set(Array.from({ length: 8 }, (_, i) => `src/file${i + 1}.ts`))
      const warning = MonitorPatterns.detectUnproductiveReads(reads, edits, referenced, 8)
      expect(warning).toBeUndefined()
    })
  })

  describe("extractGoalKeywords", () => {
    test("extracts meaningful words", () => {
      const kws = MonitorPatterns.extractGoalKeywords("Fix the authentication module in src/auth.ts")
      expect(kws).toContain("fix")
      expect(kws).toContain("authentication")
      expect(kws).toContain("module")
      expect(kws).toContain("auth.ts")
    })

    test("filters stop words", () => {
      const kws = MonitorPatterns.extractGoalKeywords("the is a for to of in on with")
      expect(kws).toHaveLength(0)
    })

    test("filters short words", () => {
      const kws = MonitorPatterns.extractGoalKeywords("do it on go")
      expect(kws).toHaveLength(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Monitor integration tests
// ---------------------------------------------------------------------------

describe("Monitor", () => {
  const sessionID = "test-session-monitor"

  beforeEach(() => {
    Monitor.clear(sessionID)
  })

  test("createState returns empty state", () => {
    const state = Monitor.createState()
    expect(state.step).toBe(0)
    expect(state.readCounts.size).toBe(0)
    expect(state.editCounts.size).toBe(0)
    expect(state.consecutiveFailures).toBe(0)
  })

  test("recordStep increments step counter", () => {
    Monitor.recordStep(sessionID, [])
    expect(Monitor.getState(sessionID).step).toBe(1)
    Monitor.recordStep(sessionID, [])
    expect(Monitor.getState(sessionID).step).toBe(2)
  })

  test("recordStep tracks read counts", () => {
    Monitor.recordStep(sessionID, [
      makeToolPart("read", { file_path: "src/foo.ts" }),
      makeToolPart("read", { file_path: "src/foo.ts" }),
      makeToolPart("read", { file_path: "src/bar.ts" }),
    ] as any)
    const state = Monitor.getState(sessionID)
    expect(state.readCounts.get("src/foo.ts")).toBe(2)
    expect(state.readCounts.get("src/bar.ts")).toBe(1)
  })

  test("recordStep tracks edit counts", () => {
    Monitor.recordStep(sessionID, [
      makeToolPart("edit", { file_path: "src/foo.ts" }),
      makeToolPart("edit", { file_path: "src/foo.ts" }),
    ] as any)
    expect(Monitor.getState(sessionID).editCounts.get("src/foo.ts")).toBe(2)
  })

  test("check returns no warnings for fresh session", () => {
    const warnings = Monitor.check(sessionID, [])
    expect(warnings).toHaveLength(0)
  })

  test("check detects circular edits", () => {
    // Simulate 3 edits to same file
    for (let i = 0; i < 3; i++) {
      Monitor.recordStep(sessionID, [
        makeToolPart("edit", { file_path: "src/foo.ts" }),
      ] as any)
    }
    const warnings = Monitor.check(sessionID, [])
    const circularWarning = warnings.find((w) => w.signal === "circular_edits")
    expect(circularWarning).toBeDefined()
  })

  test("updateTokens and check detects context burn", () => {
    Monitor.getState(sessionID).step = 3
    Monitor.updateTokens(sessionID, 85000, 100000)
    const warnings = Monitor.check(sessionID, [])
    const burnWarning = warnings.find((w) => w.signal === "context_burn")
    expect(burnWarning).toBeDefined()
    expect(burnWarning!.severity).toBe("critical")
  })

  test("format returns empty string when no warnings", () => {
    const output = Monitor.format([], 1)
    expect(output).toBe("")
  })

  test("format produces XML block with warnings", () => {
    const warnings: MonitorSignals.Warning[] = [
      { signal: "circular_edits", severity: "warn", message: "foo.ts edited 3 times" },
    ]
    const output = Monitor.format(warnings, 5, { used: 50000, total: 100000 })
    expect(output).toContain("<monitor>")
    expect(output).toContain("</monitor>")
    expect(output).toContain("Step 5")
    expect(output).toContain("50%")
    expect(output).toContain("foo.ts edited 3 times")
  })

  test("format renders severity prefixes correctly", () => {
    const warnings: MonitorSignals.Warning[] = [
      { signal: "verification_spiral", severity: "critical", message: "critical msg" },
      { signal: "circular_edits", severity: "warn", message: "warn msg" },
      { signal: "redundant_reads", severity: "info", message: "info msg" },
    ]
    const output = Monitor.format(warnings, 3)
    expect(output).toContain("CRITICAL: critical msg")
    expect(output).toContain("Warning: warn msg")
    expect(output).toContain("Note: info msg")
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolPart(tool: string, input: Record<string, unknown>) {
  return {
    type: "tool" as const,
    tool,
    id: "part-1",
    callID: "call-1",
    sessionID: "test-session",
    messageID: "msg-1",
    state: {
      status: "completed" as const,
      input,
      output: "done",
      title: "",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  }
}
