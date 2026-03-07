import { describe, expect, test } from "bun:test"
import { SessionState } from "../../src/session/state"
import type { MessageV2 } from "../../src/session/message-v2"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0

/** Creates a unique ID with a prefix for deterministic-ish test output. */
function uid(prefix: string): string {
  return `${prefix}_${++idCounter}`
}

/** Builds a minimal mock assistant message containing a single state tool call. */
function makeStateToolCall(
  operation: string,
  params: Record<string, any>,
): MessageV2.WithParts {
  const msgID = uid("msg")
  return {
    info: {
      id: msgID,
      sessionID: "test-session",
      role: "assistant",
      time: { created: Date.now() },
      mode: "default",
      agent: "default",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      path: { cwd: "/tmp", root: "/tmp" },
    } as any,
    parts: [
      {
        type: "tool" as const,
        tool: "state",
        id: uid("part"),
        callID: uid("call"),
        sessionID: "test-session",
        messageID: msgID,
        state: {
          status: "completed" as const,
          input: { operation, ...params },
          output: "State updated.",
          title: "State",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      } as any,
    ],
  }
}

/** Builds a mock assistant message with a non-state tool call. */
function makeOtherToolCall(tool: string): MessageV2.WithParts {
  const msgID = uid("msg")
  return {
    info: {
      id: msgID,
      sessionID: "test-session",
      role: "assistant",
      time: { created: Date.now() },
      mode: "default",
      agent: "default",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      path: { cwd: "/tmp", root: "/tmp" },
    } as any,
    parts: [
      {
        type: "tool" as const,
        tool,
        id: uid("part"),
        callID: uid("call"),
        sessionID: "test-session",
        messageID: msgID,
        state: {
          status: "completed" as const,
          input: { command: "ls" },
          output: "Done.",
          title: "",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      } as any,
    ],
  }
}

/** Builds a mock user message with a text part. */
function makeUserMessage(text: string): MessageV2.WithParts {
  const msgID = uid("msg")
  return {
    info: {
      id: msgID,
      sessionID: "test-session",
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "test", modelID: "test" },
    } as any,
    parts: [
      {
        type: "text" as const,
        id: uid("part"),
        sessionID: "test-session",
        messageID: msgID,
        text,
      } as any,
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionState", () => {
  // -----------------------------------------------------------------------
  // empty()
  // -----------------------------------------------------------------------
  describe("empty", () => {
    test("returns valid state with version 1", () => {
      const state = SessionState.empty()
      expect(state.version).toBe(1)
    })

    test("sets goal if provided", () => {
      const state = SessionState.empty("Refactor the auth module")
      expect(state.goal).toBe("Refactor the auth module")
    })

    test("all arrays are empty", () => {
      const state = SessionState.empty()
      expect(state.plan).toEqual([])
      expect(state.decisions).toEqual([])
      expect(state.failedApproaches).toEqual([])
      expect(state.workingSet).toEqual([])
      expect(state.invariants).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // extract() — basic
  // -----------------------------------------------------------------------
  describe("extract — basic", () => {
    test("returns undefined when no state tool calls exist", () => {
      const messages = [
        makeUserMessage("Hello"),
        makeOtherToolCall("bash"),
      ]
      const result = SessionState.extract(messages)
      expect(result).toBeUndefined()
    })

    test("extracts state from a single init operation", () => {
      const messages = [
        makeStateToolCall("init", {
          goal: "Fix bug #123",
          plan: [{ id: "s1", step: "Read the code", status: "pending" }],
        }),
      ]
      const state = SessionState.extract(messages)
      expect(state).toBeDefined()
      expect(state!.goal).toBe("Fix bug #123")
      expect(state!.plan).toHaveLength(1)
      expect(state!.plan[0].step).toBe("Read the code")
    })

    test("replays multiple operations in order", () => {
      const messages = [
        makeStateToolCall("init", {
          goal: "Implement feature X",
          plan: [{ id: "s1", step: "Design API", status: "pending" }],
        }),
        makeStateToolCall("update_plan", {
          step_id: "s1", step_status: "done",
        }),
        makeStateToolCall("add_decision", {
          choice: "Using REST over GraphQL",
        }),
      ]
      const state = SessionState.extract(messages)
      expect(state).toBeDefined()
      expect(state!.goal).toBe("Implement feature X")
      expect(state!.plan[0].status).toBe("done")
      expect(state!.decisions).toHaveLength(1)
      expect(state!.decisions[0].choice).toBe("Using REST over GraphQL")
    })

    test("handles interleaved non-state messages", () => {
      const messages = [
        makeStateToolCall("init", {
          goal: "Task A",
          plan: [{ id: "s1", step: "Step 1", status: "pending" }],
        }),
        makeUserMessage("What about the tests?"),
        makeOtherToolCall("bash"),
        makeStateToolCall("add_decision", {
          choice: "Skip integration tests for now",
        }),
      ]
      const state = SessionState.extract(messages)
      expect(state).toBeDefined()
      expect(state!.goal).toBe("Task A")
      expect(state!.decisions.some((d) => d.choice === "Skip integration tests for now")).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // extract() — operations
  // -----------------------------------------------------------------------
  describe("extract — operations", () => {
    test("init sets goal and plan", () => {
      const messages = [
        makeStateToolCall("init", {
          goal: "Migrate database",
          plan: [
            { id: "s1", step: "Backup data", status: "pending" },
            { id: "s2", step: "Run migration", status: "pending" },
          ],
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.goal).toBe("Migrate database")
      expect(state.plan).toHaveLength(2)
      expect(state.plan[0].id).toBe("s1")
      expect(state.plan[1].id).toBe("s2")
    })

    test("update_plan updates step status by ID", () => {
      const messages = [
        makeStateToolCall("init", {
          goal: "Build feature",
          plan: [
            { id: "s1", step: "Design", status: "pending" },
            { id: "s2", step: "Implement", status: "pending" },
          ],
        }),
        makeStateToolCall("update_plan", {
          step_id: "s1", step_status: "done",
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.plan[0].status).toBe("done")
      expect(state.plan[1].status).toBe("pending")
    })

    test("update_plan adds new steps", () => {
      const messages = [
        makeStateToolCall("init", {
          goal: "Build feature",
          plan: [{ id: "s1", step: "Design", status: "pending" }],
        }),
        makeStateToolCall("update_plan", {
          new_steps: [{ id: "s3", step: "Write tests", status: "pending" }],
        }),
      ]
      const state = SessionState.extract(messages)!
      // Should contain original step plus the new one
      expect(state.plan.length).toBeGreaterThanOrEqual(2)
      const newStep = state.plan.find((s) => s.id === "s3")
      expect(newStep).toBeDefined()
      expect(newStep!.step).toBe("Write tests")
    })

    test("add_decision appends to decisions array", () => {
      const messages = [
        makeStateToolCall("init", { goal: "Task" }),
        makeStateToolCall("add_decision", { choice: "Decision A" }),
        makeStateToolCall("add_decision", { choice: "Decision B" }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.decisions).toHaveLength(2)
      expect(state.decisions[0].choice).toBe("Decision A")
      expect(state.decisions[1].choice).toBe("Decision B")
    })

    test("record_failure appends to failedApproaches", () => {
      const messages = [
        makeStateToolCall("init", { goal: "Fix the flaky test" }),
        makeStateToolCall("record_failure", {
          approach: "Tried increasing timeout — still flaky",
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.failedApproaches).toHaveLength(1)
      expect(state.failedApproaches[0].approach).toBe("Tried increasing timeout — still flaky")
    })

    test("update_working_set adds files", () => {
      const messages = [
        makeStateToolCall("init", { goal: "Refactor" }),
        makeStateToolCall("update_working_set", {
          add_files: ["src/auth.ts", "src/session.ts"],
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.workingSet).toContain("src/auth.ts")
      expect(state.workingSet).toContain("src/session.ts")
    })

    test("update_working_set removes files", () => {
      const messages = [
        makeStateToolCall("init", { goal: "Cleanup" }),
        makeStateToolCall("update_working_set", {
          add_files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        }),
        makeStateToolCall("update_working_set", {
          remove_files: ["src/b.ts"],
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.workingSet).toContain("src/a.ts")
      expect(state.workingSet).not.toContain("src/b.ts")
      expect(state.workingSet).toContain("src/c.ts")
    })

    test("update_working_set handles both add and remove", () => {
      const messages = [
        makeStateToolCall("init", { goal: "Refactor" }),
        makeStateToolCall("update_working_set", {
          add_files: ["src/old.ts", "src/keep.ts"],
        }),
        makeStateToolCall("update_working_set", {
          add_files: ["src/new.ts"],
          remove_files: ["src/old.ts"],
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.workingSet).toContain("src/keep.ts")
      expect(state.workingSet).toContain("src/new.ts")
      expect(state.workingSet).not.toContain("src/old.ts")
    })

    test("add_invariant appends to invariants", () => {
      const messages = [
        makeStateToolCall("init", { goal: "Performance tuning" }),
        makeStateToolCall("add_invariant", {
          invariant: "Response time must stay under 200ms",
        }),
        makeStateToolCall("add_invariant", {
          invariant: "No new dependencies allowed",
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.invariants).toEqual([
        "Response time must stay under 200ms",
        "No new dependencies allowed",
      ])
    })

    test("set_checkpoint sets checkpoint field", () => {
      const messages = [
        makeStateToolCall("init", { goal: "Long task" }),
        makeStateToolCall("set_checkpoint", {
          checkpoint: "Completed phase 1: all tests passing",
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.checkpoint).toBe("Completed phase 1: all tests passing")
    })
  })

  // -----------------------------------------------------------------------
  // extract() — edge cases
  // -----------------------------------------------------------------------
  describe("extract — edge cases", () => {
    test("multiple inits: last init resets state", () => {
      const messages = [
        makeStateToolCall("init", {
          goal: "Old goal",
          plan: [{ id: "s1", step: "Old step", status: "done" }],
        }),
        makeStateToolCall("add_decision", { choice: "Old decision" }),
        makeStateToolCall("init", {
          goal: "New goal",
          plan: [{ id: "s2", step: "New step", status: "pending" }],
        }),
      ]
      const state = SessionState.extract(messages)!
      expect(state.goal).toBe("New goal")
      expect(state.plan).toHaveLength(1)
      expect(state.plan[0].id).toBe("s2")
      // Old decision should be cleared by the second init
      expect(state.decisions).toEqual([])
    })

    test("empty messages array returns undefined", () => {
      const result = SessionState.extract([])
      expect(result).toBeUndefined()
    })

    test("messages with no tool parts returns undefined", () => {
      const messages = [
        makeUserMessage("Hello"),
        makeUserMessage("Can you help?"),
      ]
      const result = SessionState.extract(messages)
      expect(result).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // format()
  // -----------------------------------------------------------------------
  describe("format", () => {
    test("includes goal", () => {
      const state = SessionState.empty("Build the auth system")
      const output = SessionState.format(state)
      expect(output).toContain("Build the auth system")
    })

    test("includes plan steps with status markers", () => {
      const state = {
        ...SessionState.empty("Task"),
        plan: [
          { id: "s1", step: "Read code", status: "done" as const },
          { id: "s2", step: "Write tests", status: "active" as const },
          { id: "s3", step: "Refactor", status: "pending" as const },
        ],
      }
      const output = SessionState.format(state)
      // Should include some kind of status indicator per step
      expect(output).toContain("Read code")
      expect(output).toContain("Write tests")
      expect(output).toContain("Refactor")
    })

    test("omits empty sections", () => {
      const state = SessionState.empty("Simple task")
      const output = SessionState.format(state)
      // With no decisions, should not have a "Decisions" header
      expect(output).not.toContain("Decisions")
      expect(output).not.toContain("Failed")
      expect(output).not.toContain("Invariants")
    })

    test("includes working set files", () => {
      const state = {
        ...SessionState.empty("Edit files"),
        workingSet: ["src/auth.ts", "src/session.ts"],
      }
      const output = SessionState.format(state)
      expect(output).toContain("src/auth.ts")
      expect(output).toContain("src/session.ts")
    })

    test("includes decisions", () => {
      const state = {
        ...SessionState.empty("Design"),
        decisions: [
          { choice: "Use REST API", reason: "simpler", timestamp: Date.now() },
          { choice: "Postgres over SQLite", reason: "scalability", timestamp: Date.now() },
        ],
      }
      const output = SessionState.format(state)
      expect(output).toContain("Use REST API")
      expect(output).toContain("Postgres over SQLite")
    })

    test("includes failed approaches", () => {
      const state = {
        ...SessionState.empty("Debug"),
        failedApproaches: [
          { approach: "Tried monkey-patching — broke other tests", reason: "broke tests", timestamp: Date.now() },
        ],
      }
      const output = SessionState.format(state)
      expect(output).toContain("Tried monkey-patching — broke other tests")
    })

    test("includes invariants", () => {
      const state = {
        ...SessionState.empty("Perf work"),
        invariants: ["No regressions in p99 latency"],
      }
      const output = SessionState.format(state)
      expect(output).toContain("No regressions in p99 latency")
    })

    test("output is wrapped in <session-state> tags", () => {
      const state = SessionState.empty("Any goal")
      const output = SessionState.format(state)
      expect(output).toContain("<session-state>")
      expect(output).toContain("</session-state>")
    })
  })

  // -----------------------------------------------------------------------
  // merge()
  // -----------------------------------------------------------------------
  describe("merge", () => {
    test("merges goal", () => {
      const current = SessionState.empty("Old goal")
      const merged = SessionState.merge(current, { goal: "New goal" })
      expect(merged.goal).toBe("New goal")
    })

    test("merges plan (replaces)", () => {
      const current = {
        ...SessionState.empty("Task"),
        plan: [{ id: "s1", step: "Old step", status: "done" as const }],
      }
      const newPlan: SessionState.PlanStep[] = [{ id: "s2", step: "New step", status: "pending" }]
      const merged = SessionState.merge(current, { plan: newPlan })
      expect(merged.plan).toEqual(newPlan)
    })

    test("merges workingSet", () => {
      const current = {
        ...SessionState.empty("Task"),
        workingSet: ["src/a.ts"],
      }
      const merged = SessionState.merge(current, {
        workingSet: ["src/b.ts", "src/c.ts"],
      })
      expect(merged.workingSet).toEqual(["src/b.ts", "src/c.ts"])
    })
  })
})
