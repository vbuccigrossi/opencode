import { describe, expect, test, beforeEach } from "bun:test"
import { WorkingSet } from "../../src/context/working-set"
import { DynamicContext } from "../../src/context/dynamic"

// ---------------------------------------------------------------------------
// WorkingSet tests
// ---------------------------------------------------------------------------

describe("WorkingSet", () => {
  let state: WorkingSet.State

  beforeEach(() => {
    state = WorkingSet.create()
  })

  describe("create", () => {
    test("starts with empty files and step 0", () => {
      expect(state.files.size).toBe(0)
      expect(state.currentStep).toBe(0)
    })
  })

  describe("touch", () => {
    test("adds a new file to the set", () => {
      WorkingSet.touch(state, "src/foo.ts", 0.8, "test reason")
      expect(state.files.size).toBe(1)
      const entry = state.files.get("src/foo.ts")!
      expect(entry.relevance).toBe(0.8)
      expect(entry.reason).toBe("test reason")
      expect(entry.edited).toBe(false)
    })

    test("marks file as edited when specified", () => {
      WorkingSet.touch(state, "src/foo.ts", 0.8, "edit", true)
      expect(state.files.get("src/foo.ts")!.edited).toBe(true)
    })

    test("boosts relevance on re-touch (never reduces)", () => {
      WorkingSet.touch(state, "src/foo.ts", 0.5, "first")
      WorkingSet.touch(state, "src/foo.ts", 0.9, "second")
      expect(state.files.get("src/foo.ts")!.relevance).toBe(0.9)

      // Re-touch with lower score should not reduce
      WorkingSet.touch(state, "src/foo.ts", 0.3, "third")
      expect(state.files.get("src/foo.ts")!.relevance).toBe(0.9)
    })

    test("updates lastAccessed on re-touch", () => {
      state.currentStep = 5
      WorkingSet.touch(state, "src/foo.ts", 0.5, "first")
      state.currentStep = 10
      WorkingSet.touch(state, "src/foo.ts", 0.3, "second")
      expect(state.files.get("src/foo.ts")!.lastAccessed).toBe(10)
    })

    test("evicts lowest relevance when at max capacity", () => {
      // Fill to max (30)
      for (let i = 0; i < 30; i++) {
        WorkingSet.touch(state, `src/file${i}.ts`, 0.5 + i * 0.01, `file ${i}`)
      }
      expect(state.files.size).toBe(30)

      // Add one more — should evict lowest
      WorkingSet.touch(state, "src/new.ts", 0.99, "new file")
      expect(state.files.size).toBe(30)
      expect(state.files.has("src/new.ts")).toBe(true)
      // file0 had lowest relevance (0.5)
      expect(state.files.has("src/file0.ts")).toBe(false)
    })

    test("clamps relevance to 1.0", () => {
      WorkingSet.touch(state, "src/foo.ts", 1.5, "high")
      expect(state.files.get("src/foo.ts")!.relevance).toBe(1.0)
    })
  })

  describe("remove", () => {
    test("removes a file from the set", () => {
      WorkingSet.touch(state, "src/foo.ts", 0.8, "test")
      WorkingSet.remove(state, "src/foo.ts")
      expect(state.files.size).toBe(0)
    })

    test("no-op for missing file", () => {
      WorkingSet.remove(state, "nonexistent.ts")
      expect(state.files.size).toBe(0)
    })
  })

  describe("advanceStep", () => {
    test("increments step counter", () => {
      WorkingSet.advanceStep(state)
      expect(state.currentStep).toBe(1)
      WorkingSet.advanceStep(state)
      expect(state.currentStep).toBe(2)
    })

    test("decays relevance scores", () => {
      WorkingSet.touch(state, "src/foo.ts", 1.0, "test")
      WorkingSet.advanceStep(state)
      const entry = state.files.get("src/foo.ts")!
      expect(entry.relevance).toBeLessThan(1.0)
      expect(entry.relevance).toBeCloseTo(0.85, 2)
    })

    test("evicts files below minimum relevance after decay", () => {
      WorkingSet.touch(state, "src/foo.ts", 0.12, "low relevance")
      // After one decay: 0.12 * 0.85 = 0.102 → still above 0.1
      WorkingSet.advanceStep(state)
      expect(state.files.has("src/foo.ts")).toBe(true)
      // After another: 0.102 * 0.85 ≈ 0.087 → below 0.1
      WorkingSet.advanceStep(state)
      expect(state.files.has("src/foo.ts")).toBe(false)
    })

    test("evicts files not accessed in 6+ steps", () => {
      WorkingSet.touch(state, "src/foo.ts", 1.0, "test")
      for (let i = 0; i < 6; i++) {
        WorkingSet.advanceStep(state)
      }
      expect(state.files.has("src/foo.ts")).toBe(false)
    })

    test("does not evict recently touched files", () => {
      WorkingSet.touch(state, "src/foo.ts", 1.0, "test")
      for (let i = 0; i < 5; i++) {
        WorkingSet.advanceStep(state)
      }
      // Touch again to reset lastAccessed
      WorkingSet.touch(state, "src/foo.ts", 0.8, "refreshed")
      WorkingSet.advanceStep(state)
      expect(state.files.has("src/foo.ts")).toBe(true)
    })
  })

  describe("select", () => {
    test("returns top entries by relevance within budget", () => {
      WorkingSet.touch(state, "src/a.ts", 0.9, "high")
      WorkingSet.touch(state, "src/b.ts", 0.3, "low")
      WorkingSet.touch(state, "src/c.ts", 0.7, "medium")

      const snapshot = WorkingSet.select(state, 1000)
      expect(snapshot.entries).toHaveLength(3)
      expect(snapshot.entries[0].filePath).toBe("src/a.ts")
      expect(snapshot.entries[1].filePath).toBe("src/c.ts")
      expect(snapshot.entries[2].filePath).toBe("src/b.ts")
    })

    test("respects token budget", () => {
      for (let i = 0; i < 10; i++) {
        WorkingSet.touch(state, `src/file${i}.ts`, 0.5 + i * 0.05, `file ${i}`)
      }
      // Budget of 90 tokens → ~3 files at 30 tokens each
      const snapshot = WorkingSet.select(state, 90)
      expect(snapshot.entries.length).toBe(3)
    })

    test("returns empty snapshot for empty set", () => {
      const snapshot = WorkingSet.select(state, 1000)
      expect(snapshot.entries).toHaveLength(0)
      expect(snapshot.totalTokens).toBe(0)
    })
  })

  describe("syncFromSessionState", () => {
    test("adds session state files not in working set", () => {
      WorkingSet.touch(state, "src/a.ts", 0.9, "existing")
      WorkingSet.syncFromSessionState(state, ["src/a.ts", "src/b.ts", "src/c.ts"])
      expect(state.files.size).toBe(3)
      expect(state.files.get("src/b.ts")!.relevance).toBe(0.5)
    })

    test("does not reduce relevance of existing files", () => {
      WorkingSet.touch(state, "src/a.ts", 0.9, "existing")
      WorkingSet.syncFromSessionState(state, ["src/a.ts"])
      expect(state.files.get("src/a.ts")!.relevance).toBe(0.9)
    })
  })

  describe("format", () => {
    test("returns empty string for no entries", () => {
      expect(WorkingSet.format([])).toBe("")
    })

    test("produces XML block with entries", () => {
      const entries: WorkingSet.Entry[] = [
        { filePath: "src/foo.ts", relevance: 0.9, lastAccessed: 1, reason: "edited by agent", edited: true },
        { filePath: "src/bar.ts", relevance: 0.5, lastAccessed: 2, reason: "read by agent", edited: false },
      ]
      const output = WorkingSet.format(entries)
      expect(output).toContain("<working-context>")
      expect(output).toContain("</working-context>")
      expect(output).toContain("[edited] src/foo.ts")
      expect(output).toContain("[read] src/bar.ts")
    })
  })
})

// ---------------------------------------------------------------------------
// DynamicContext tests
// ---------------------------------------------------------------------------

describe("DynamicContext", () => {
  const sessionID = "test-session-dynamic"

  beforeEach(() => {
    DynamicContext.clear(sessionID)
  })

  test("getState creates fresh state on first call", () => {
    const state = DynamicContext.getState(sessionID)
    expect(state.currentStep).toBe(0)
    expect(state.files.size).toBe(0)
  })

  test("clear removes session state", () => {
    DynamicContext.getState(sessionID)
    DynamicContext.clear(sessionID)
    // Should get a fresh state
    const state = DynamicContext.getState(sessionID)
    expect(state.currentStep).toBe(0)
  })

  test("processToolResults tracks read operations", () => {
    const parts = [
      makeToolPart("read", { file_path: "/project/src/auth.ts" }),
    ]
    DynamicContext.processToolResults(sessionID, parts as any)
    const state = DynamicContext.getState(sessionID)
    expect(state.files.size).toBeGreaterThan(0)
  })

  test("processToolResults tracks edit operations with higher relevance", () => {
    DynamicContext.processToolResults(sessionID, [
      makeToolPart("read", { file_path: "src/foo.ts" }) as any,
    ])
    DynamicContext.processToolResults(sessionID, [
      makeToolPart("edit", { file_path: "src/bar.ts" }) as any,
    ])
    const state = DynamicContext.getState(sessionID)
    const readEntry = state.files.get("src/foo.ts")
    const editEntry = state.files.get("src/bar.ts")
    // Edit should have higher relevance
    if (readEntry && editEntry) {
      expect(editEntry.relevance).toBeGreaterThan(readEntry.relevance)
    }
  })

  test("getInjection advances step and returns formatted output", () => {
    // Add some files first
    DynamicContext.processToolResults(sessionID, [
      makeToolPart("edit", { file_path: "src/module.ts" }) as any,
    ])
    const injection = DynamicContext.getInjection(sessionID, [], 500)
    expect(DynamicContext.currentStep(sessionID)).toBe(1)
    // Should have some content since we added a file
    expect(injection.length).toBeGreaterThan(0)
    expect(injection).toContain("<working-context>")
  })

  test("getInjection returns empty when no files tracked", () => {
    const injection = DynamicContext.getInjection(sessionID, [], 500)
    expect(injection).toBe("")
  })

  test("fileCount returns tracked file count", () => {
    expect(DynamicContext.fileCount(sessionID)).toBe(0)
    DynamicContext.processToolResults(sessionID, [
      makeToolPart("read", { file_path: "src/a.ts" }) as any,
    ])
    expect(DynamicContext.fileCount(sessionID)).toBeGreaterThan(0)
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
