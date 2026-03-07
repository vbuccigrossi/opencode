import { describe, expect, test } from "bun:test"
import { VerifyEngine } from "../../src/verify/engine"

describe("verify.parsing", () => {
  describe("extended error formats", () => {
    test("parses Rust error with location line", async () => {
      const result = await VerifyEngine.run("/tmp", {
        typecheck: true,
        commands: {
          typecheck: `printf 'error[E0382]: borrow of moved value\n  --> src/main.rs:10:5\n' && exit 1`,
        },
        timeout: 5_000,
      })

      expect(result.success).toBe(false)
      const error = result.steps[0].errors[0]
      expect(error.code).toBe("E0382")
      expect(error.message).toBe("borrow of moved value")
      expect(error.file).toBe("src/main.rs")
      expect(error.line).toBe(10)
      expect(error.column).toBe(5)
    })

    test("parses pytest FAILED format", async () => {
      const result = await VerifyEngine.run("/tmp", {
        typecheck: false,
        test: true,
        commands: {
          test: "echo 'FAILED tests/test_auth.py::test_login - AssertionError: expected True' && exit 1",
        },
        timeout: 5_000,
      })

      expect(result.success).toBe(false)
      const error = result.steps[0].errors.find((e) => e.file === "tests/test_auth.py")
      expect(error).toBeDefined()
      expect(error!.message).toContain("test_login")
    })

    test("parses Jest FAIL format", async () => {
      const result = await VerifyEngine.run("/tmp", {
        typecheck: false,
        test: true,
        commands: {
          test: "echo '  FAIL src/auth.test.ts' && exit 1",
        },
        timeout: 5_000,
      })

      expect(result.success).toBe(false)
      const error = result.steps[0].errors.find((e) => e.file === "src/auth.test.ts")
      expect(error).toBeDefined()
    })
  })

  describe("per-step timeouts", () => {
    test("uses step-specific timeout", async () => {
      const result = await VerifyEngine.run("/tmp", {
        typecheck: true,
        commands: { typecheck: "echo 'ok'" },
        stepTimeouts: { typecheck: 5_000 },
        timeout: 1_000,
      })
      // Should use stepTimeouts.typecheck (5s), not global (1s)
      expect(result.success).toBe(true)
    })
  })
})
