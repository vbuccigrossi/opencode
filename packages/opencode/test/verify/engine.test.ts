import { describe, expect, test } from "bun:test"
import { VerifyEngine } from "../../src/verify/engine"

describe("verify.engine", () => {
  describe("error parsing", () => {
    test("formats successful result", () => {
      const result: VerifyEngine.VerifyResult = {
        steps: [{ step: "typecheck", success: true, errors: [], output: "", durationMs: 100 }],
        success: true,
        totalErrors: 0,
        totalWarnings: 0,
        durationMs: 100,
      }
      const text = VerifyEngine.format(result)
      expect(text).toContain("passed")
      expect(text).toContain("typecheck")
    })

    test("formats failed result with errors", () => {
      const result: VerifyEngine.VerifyResult = {
        steps: [
          {
            step: "typecheck",
            success: false,
            errors: [
              {
                file: "src/main.ts",
                line: 10,
                column: 5,
                message: "Type 'string' is not assignable to type 'number'",
                severity: "error",
                code: "TS2322",
              },
            ],
            output: "error output here",
            durationMs: 200,
          },
        ],
        success: false,
        totalErrors: 1,
        totalWarnings: 0,
        durationMs: 200,
      }
      const text = VerifyEngine.format(result)
      expect(text).toContain("FAILED")
      expect(text).toContain("src/main.ts:10:5")
      expect(text).toContain("TS2322")
      expect(text).toContain("Type 'string' is not assignable")
    })

    test("formats multi-step result", () => {
      const result: VerifyEngine.VerifyResult = {
        steps: [
          { step: "typecheck", success: true, errors: [], output: "", durationMs: 100 },
          {
            step: "test",
            success: false,
            errors: [
              { file: "test/auth.test.ts", line: 25, message: "Expected true, received false", severity: "error" },
            ],
            output: "test failure",
            durationMs: 500,
          },
        ],
        success: false,
        totalErrors: 1,
        totalWarnings: 0,
        durationMs: 600,
      }
      const text = VerifyEngine.format(result)
      // Should only show failed steps
      expect(text).toContain("test FAILED")
      expect(text).toContain("test/auth.test.ts:25")
    })
  })

  describe("live verification", () => {
    test(
      "runs typecheck on current project",
      async () => {
        // This test runs the actual typecheck on the opencode project
        const result = await VerifyEngine.run(
          "/home/ebrown/Desktop/projects/opencode/packages/opencode",
          {
            typecheck: true,
            test: false,
            lint: false,
            build: false,
            commands: { typecheck: "echo 'all clear'" },
            timeout: 10_000,
          },
        )

        expect(result.steps).toHaveLength(1)
        expect(result.steps[0].step).toBe("typecheck")
        expect(result.steps[0].success).toBe(true)
        expect(result.durationMs).toBeGreaterThan(0)
      },
      30_000,
    )

    test("handles command that produces errors", async () => {
      const result = await VerifyEngine.run("/tmp", {
        typecheck: true,
        commands: {
          typecheck: "echo 'src/bad.ts:5:3 - error TS2345: Argument type mismatch' && exit 1",
        },
        timeout: 5_000,
      })

      expect(result.steps).toHaveLength(1)
      expect(result.steps[0].success).toBe(false)
      expect(result.steps[0].errors.length).toBeGreaterThan(0)
    })

    test("skips steps with no commands", async () => {
      const result = await VerifyEngine.run("/tmp", {
        typecheck: true,
        test: true,
        commands: {}, // No commands detected
      })

      expect(result.steps).toHaveLength(0)
      expect(result.success).toBe(true)
    })
  })
})
