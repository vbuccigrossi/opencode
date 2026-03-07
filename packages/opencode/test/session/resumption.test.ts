import { describe, expect, test, beforeEach } from "bun:test"
import { Resumption } from "../../src/session/resumption"
import { SessionState } from "../../src/session/state"
import { Scratchpad } from "../../src/scratchpad"
import type { MessageV2 } from "../../src/session/message-v2"

/** Build a minimal messages array with state and think tool calls. */
function buildMessages(opts: {
  goal?: string
  plan?: SessionState.PlanStep[]
  thoughts?: string[]
  decisions?: SessionState.Decision[]
  invariants?: string[]
  failedApproaches?: SessionState.FailedApproach[]
  workingSet?: string[]
}): MessageV2.WithParts[] {
  const messages: MessageV2.WithParts[] = []
  const parts: any[] = []

  // State tool call with init operation (required for other ops to work)
  // init must have a goal or it's a no-op
  const needsInit = opts.goal || opts.plan || opts.decisions || opts.workingSet || opts.invariants || opts.failedApproaches
  if (needsInit) {
    parts.push({
      type: "tool",
      tool: "state",
      state: {
        status: "completed",
        input: {
          operation: "init",
          goal: opts.goal || "default goal",
          plan: opts.plan ?? [],
        },
      },
    })
  }

  // Add decisions via add_decision operations
  if (opts.decisions) {
    for (const d of opts.decisions) {
      parts.push({
        type: "tool",
        tool: "state",
        state: {
          status: "completed",
          input: {
            operation: "add_decision",
            choice: d.choice,
            reason: d.reason,
            alternatives: d.alternatives,
            timestamp: d.timestamp,
          },
        },
      })
    }
  }

  // Add working set via update_working_set
  if (opts.workingSet && opts.workingSet.length > 0) {
    parts.push({
      type: "tool",
      tool: "state",
      state: {
        status: "completed",
        input: {
          operation: "update_working_set",
          add_files: opts.workingSet,
        },
      },
    })
  }

  // Add invariants via add_invariant
  if (opts.invariants) {
    for (const inv of opts.invariants) {
      parts.push({
        type: "tool",
        tool: "state",
        state: {
          status: "completed",
          input: {
            operation: "add_invariant",
            invariant: inv,
          },
        },
      })
    }
  }

  // Add failed approaches via record_failure
  if (opts.failedApproaches) {
    for (const fa of opts.failedApproaches) {
      parts.push({
        type: "tool",
        tool: "state",
        state: {
          status: "completed",
          input: {
            operation: "record_failure",
            approach: fa.approach,
            failure_reason: fa.reason,
            timestamp: fa.timestamp,
          },
        },
      })
    }
  }

  if (parts.length > 0) {
    messages.push({
      info: { role: "assistant" } as any,
      parts,
    })
  }

  // Think tool calls
  if (opts.thoughts) {
    for (const thought of opts.thoughts) {
      messages.push({
        info: { role: "assistant" } as any,
        parts: [
          {
            type: "tool",
            tool: "think",
            state: {
              status: "completed",
              input: { thought },
            },
          } as any,
        ],
      })
    }
  }

  return messages
}

describe("Resumption", () => {
  beforeEach(() => {
    Resumption.clearAll()
    Scratchpad.clearIndex("test-session")
  })

  describe("snapshot", () => {
    test("captures goal and plan from session state", () => {
      const messages = buildMessages({
        goal: "Add user authentication",
        plan: [
          { id: "1", step: "Add auth middleware", status: "done" },
          { id: "2", step: "Create login endpoint", status: "active" },
          { id: "3", step: "Add JWT validation", status: "pending" },
        ],
      })

      const snap = Resumption.snapshot("test-session", messages)
      expect(snap.goal).toBe("Add user authentication")
      expect(snap.activeStep).toContain("Create login endpoint")
      expect(snap.planProgress).toBe("1/3 steps completed")
    })

    test("captures working set", () => {
      const messages = buildMessages({
        workingSet: ["src/auth.ts", "src/middleware.ts"],
      })

      const snap = Resumption.snapshot("test-session", messages)
      expect(snap.workingSet).toEqual(["src/auth.ts", "src/middleware.ts"])
    })

    test("captures recent decisions", () => {
      const messages = buildMessages({
        decisions: [
          { choice: "Use JWT", reason: "Stateless auth", timestamp: Date.now() },
          { choice: "bcrypt for hashing", reason: "Industry standard", timestamp: Date.now() },
        ],
      })

      const snap = Resumption.snapshot("test-session", messages)
      expect(snap.recentDecisions.length).toBe(2)
      expect(snap.recentDecisions[0]).toContain("Use JWT")
    })

    test("captures scratchpad thoughts (condensed)", () => {
      const messages = buildMessages({
        thoughts: [
          "First I need to understand the auth flow",
          "The middleware pattern looks correct",
          "A very long thought that goes on and on " + "x".repeat(250),
        ],
      })

      const snap = Resumption.snapshot("test-session", messages)
      expect(snap.lastThoughts.length).toBe(3)
      // Long thought should be truncated
      expect(snap.lastThoughts[2].length).toBeLessThanOrEqual(204) // 200 + "..."
    })

    test("captures invariants and failed approaches", () => {
      const messages = buildMessages({
        invariants: ["Do not break existing API"],
        failedApproaches: [
          { approach: "Passport.js", reason: "Too heavy", timestamp: Date.now() },
        ],
      })

      const snap = Resumption.snapshot("test-session", messages)
      expect(snap.invariants).toEqual(["Do not break existing API"])
      expect(snap.failedApproaches.length).toBe(1)
      expect(snap.failedApproaches[0]).toContain("Passport.js")
    })

    test("captures extras (modifications, errors)", () => {
      const messages = buildMessages({})
      const snap = Resumption.snapshot("test-session", messages, {
        recentModifications: ["src/auth.ts", "src/login.ts"],
        pendingErrors: "TS2345: Argument type mismatch in auth.ts:15",
      })

      expect(snap.recentModifications).toEqual(["src/auth.ts", "src/login.ts"])
      expect(snap.pendingErrors).toContain("TS2345")
    })
  })

  describe("hasSnapshot and get", () => {
    test("hasSnapshot returns false initially", () => {
      expect(Resumption.hasSnapshot("test-session")).toBe(false)
    })

    test("hasSnapshot returns true after snapshot", () => {
      Resumption.snapshot("test-session", buildMessages({}))
      expect(Resumption.hasSnapshot("test-session")).toBe(true)
    })

    test("get returns the snapshot", () => {
      Resumption.snapshot("test-session", buildMessages({ goal: "Test goal" }))
      const snap = Resumption.get("test-session")
      expect(snap).toBeDefined()
      expect(snap!.goal).toBe("Test goal")
    })
  })

  describe("restore", () => {
    test("returns formatted block and consumes snapshot", () => {
      Resumption.snapshot("test-session", buildMessages({
        goal: "Fix the auth bug",
        plan: [
          { id: "1", step: "Read error logs", status: "done" },
          { id: "2", step: "Fix the handler", status: "active" },
        ],
      }))

      const block = Resumption.restore("test-session")
      expect(block).toBeDefined()
      expect(block).toContain("<resumption>")
      expect(block).toContain("</resumption>")
      expect(block).toContain("Fix the auth bug")
      expect(block).toContain("Fix the handler")

      // Should be consumed
      expect(Resumption.hasSnapshot("test-session")).toBe(false)
      expect(Resumption.restore("test-session")).toBeUndefined()
    })

    test("returns undefined when no snapshot", () => {
      expect(Resumption.restore("nonexistent")).toBeUndefined()
    })
  })

  describe("format", () => {
    test("includes all context sections", () => {
      const snap: Resumption.Snapshot = {
        sessionID: "test",
        timestamp: Date.now(),
        goal: "Implement feature X",
        activeStep: "[2] Write the handler",
        planProgress: "1/3 steps completed",
        workingSet: ["src/handler.ts", "src/router.ts"],
        recentDecisions: ["Use Express (lightweight)"],
        lastThoughts: ["Need to check error handling"],
        recentModifications: ["src/handler.ts"],
        pendingErrors: "TS2322 in handler.ts:10",
        invariants: ["Keep backward compatibility"],
        failedApproaches: ["Fastify: too different from existing code"],
      }

      const output = Resumption.format(snap)
      expect(output).toContain("<resumption>")
      expect(output).toContain("Goal: Implement feature X")
      expect(output).toContain("Plan: 1/3 steps completed")
      expect(output).toContain("Current step: [2] Write the handler")
      expect(output).toContain("Working files: src/handler.ts, src/router.ts")
      expect(output).toContain("Recently modified: src/handler.ts")
      expect(output).toContain("Use Express (lightweight)")
      expect(output).toContain("Keep backward compatibility")
      expect(output).toContain("Fastify")
      expect(output).toContain("Need to check error handling")
      expect(output).toContain("TS2322")
      expect(output).toContain("</resumption>")
    })

    test("omits empty sections", () => {
      const snap: Resumption.Snapshot = {
        sessionID: "test",
        timestamp: Date.now(),
        goal: "Simple task",
        workingSet: [],
        recentDecisions: [],
        lastThoughts: [],
        recentModifications: [],
        invariants: [],
        failedApproaches: [],
      }

      const output = Resumption.format(snap)
      expect(output).toContain("Goal: Simple task")
      expect(output).not.toContain("Working files")
      expect(output).not.toContain("Recent decisions")
      expect(output).not.toContain("Invariants")
      expect(output).not.toContain("Do NOT retry")
    })
  })

  describe("clearAll", () => {
    test("removes all snapshots", () => {
      Resumption.snapshot("s1", buildMessages({}))
      Resumption.snapshot("s2", buildMessages({}))
      Resumption.clearAll()
      expect(Resumption.hasSnapshot("s1")).toBe(false)
      expect(Resumption.hasSnapshot("s2")).toBe(false)
    })
  })
})
