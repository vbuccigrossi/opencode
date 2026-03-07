import { describe, expect, test } from "bun:test"
import { AutoExtract } from "../../src/memory/auto-extract"
import type { SessionState } from "../../src/session/state"

describe("AutoExtract", () => {
  describe("fromSession", () => {
    test("extracts strategy insight from successful session", () => {
      const state: SessionState.State = {
        version: 1,
        goal: "Add auth module",
        plan: [
          { id: "s1", step: "Design API", status: "done" },
          { id: "s2", step: "Implement handlers", status: "done" },
          { id: "s3", step: "Write tests", status: "done" },
        ],
        workingSet: ["src/auth.ts", "src/auth.test.ts"],
        decisions: [],
        invariants: [],
        failedApproaches: [],
        metadata: {},
      }

      const candidates = AutoExtract.fromSession(state, "feature", true)
      expect(candidates.length).toBeGreaterThanOrEqual(1)

      const strategyCandidate = candidates.find((c) => c.type === "strategy")
      expect(strategyCandidate).toBeDefined()
      expect(strategyCandidate!.content).toContain("feature")
      expect(strategyCandidate!.content).toContain("3 steps")
      expect(strategyCandidate!.content).toContain("verification passed")
    })

    test("extracts failed approach memories", () => {
      const state: SessionState.State = {
        version: 1,
        goal: "Fix bug",
        plan: [
          { id: "s1", step: "Try approach A", status: "failed" },
          { id: "s2", step: "Try approach B", status: "done" },
        ],
        workingSet: [],
        decisions: [],
        invariants: [],
        failedApproaches: [
          { approach: "Used regex replacement", reason: "Broke multi-line strings", timestamp: Date.now() },
        ],
        metadata: {},
      }

      const candidates = AutoExtract.fromSession(state, "bug_fix", true)
      const failureCandidate = candidates.find((c) => c.tags.includes("failure"))
      expect(failureCandidate).toBeDefined()
      expect(failureCandidate!.content).toContain("regex replacement")
      expect(failureCandidate!.content).toContain("multi-line strings")
    })

    test("extracts decisions with alternatives", () => {
      const state: SessionState.State = {
        version: 1,
        goal: "Design API",
        plan: [],
        workingSet: [],
        decisions: [
          {
            choice: "REST over GraphQL",
            reason: "simpler for our use case",
            alternatives: ["GraphQL", "gRPC"],
            timestamp: Date.now(),
          },
        ],
        invariants: [],
        failedApproaches: [],
        metadata: {},
      }

      const candidates = AutoExtract.fromSession(state, "feature", true)
      const decisionCandidate = candidates.find((c) => c.type === "architecture")
      expect(decisionCandidate).toBeDefined()
      expect(decisionCandidate!.content).toContain("REST over GraphQL")
      expect(decisionCandidate!.content).toContain("GraphQL, gRPC")
    })

    test("extracts invariants", () => {
      const state: SessionState.State = {
        version: 1,
        goal: "Perf tuning",
        plan: [],
        workingSet: [],
        decisions: [],
        invariants: ["Response time must stay under 200ms"],
        failedApproaches: [],
        metadata: {},
      }

      const candidates = AutoExtract.fromSession(state, "feature", true)
      const invariantCandidate = candidates.find((c) => c.type === "convention")
      expect(invariantCandidate).toBeDefined()
      expect(invariantCandidate!.content).toContain("200ms")
    })

    test("returns empty for minimal session", () => {
      const state: SessionState.State = {
        version: 1,
        goal: "Quick fix",
        plan: [],
        workingSet: [],
        decisions: [],
        invariants: [],
        failedApproaches: [],
        metadata: {},
      }

      const candidates = AutoExtract.fromSession(state, "simple_edit", true)
      expect(candidates).toHaveLength(0)
    })
  })

  describe("fromRepair", () => {
    test("generalizes error and creates memory candidate", () => {
      const candidate = AutoExtract.fromRepair(
        "src/auth.ts(15,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'",
        "Changed argument type from string to number",
        "src/auth.ts",
      )
      expect(candidate).toBeDefined()
      expect(candidate!.type).toBe("debugging")
      expect(candidate!.content).toContain("error TS2345")
      expect(candidate!.content).toContain("Changed argument type")
      expect(candidate!.tags).toContain("error-fix")
    })

    test("returns undefined for very short errors", () => {
      const candidate = AutoExtract.fromRepair("error", "fixed it")
      expect(candidate).toBeUndefined()
    })

    test("generalizes line numbers away", () => {
      const candidate = AutoExtract.fromRepair(
        "src/foo.ts:42:10: Type error in function call",
        "Added type assertion",
      )
      expect(candidate).toBeDefined()
      // Line numbers should be removed
      expect(candidate!.content).not.toContain("42")
      expect(candidate!.content).not.toContain(":10")
    })
  })
})
