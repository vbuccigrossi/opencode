import { describe, expect, test } from "bun:test"
import { TestParser } from "../../src/verify/test-parser"

describe("TestParser", () => {
  describe("bun format", () => {
    test("parses passing tests", () => {
      const output = `bun test v1.3.10

test/math.test.ts:
(pass) add > adds two numbers [0.12ms]
(pass) add > handles zero [0.05ms]

 2 pass
 0 fail
 2 expect() calls
Ran 2 tests across 1 files. [100ms]`

      const result = TestParser.parse(output, "bun")
      expect(result.framework).toBe("bun")
      expect(result.passed).toBe(2)
      expect(result.failed).toBe(0)
      expect(result.results.length).toBe(2)
      expect(result.results[0].status).toBe("pass")
    })

    test("parses failing tests", () => {
      const output = `bun test v1.3.10

test/math.test.ts:
(pass) add > adds two numbers [0.12ms]
(fail) add > handles negative [0.26ms]

error: expect(received).toBe(expected)

Expected: -3
Received: 3

 1 pass
 1 fail
 2 expect() calls
Ran 2 tests across 1 files. [100ms]`

      const result = TestParser.parse(output, "bun")
      expect(result.passed).toBe(1)
      expect(result.failed).toBe(1)

      const failure = result.results.find((r) => r.status === "fail")
      expect(failure).toBeDefined()
      expect(failure!.assertion).toBeDefined()
      expect(failure!.assertion!.operator).toBe("toBe")
      expect(failure!.assertion!.expected).toBe("-3")
      expect(failure!.assertion!.received).toBe("3")
    })

    test("parses skipped tests", () => {
      const output = `bun test v1.3.10

test/math.test.ts:
(pass) add > works [0.1ms]
(skip) add > pending test

 1 pass
 0 fail
Ran 2 tests across 1 files. [50ms]`

      const result = TestParser.parse(output, "bun")
      expect(result.passed).toBe(1)
      expect(result.skipped).toBe(1)
    })

    test("parses file header correctly", () => {
      const output = `bun test v1.3.10

test/utils.test.ts:
(pass) formatDate > formats correctly [0.5ms]

 1 pass
 0 fail`

      const result = TestParser.parse(output, "bun")
      expect(result.results[0].file).toBe("test/utils.test.ts")
    })
  })

  describe("jest/vitest format", () => {
    test("parses jest pass/fail markers", () => {
      const output = `PASS src/math.test.ts
  add
    ✓ adds numbers (5 ms)
    ✕ handles edge case (10 ms)

Tests:  1 failed, 1 passed, 2 total`

      const result = TestParser.parse(output, "jest")
      expect(result.framework).toBe("jest")
      expect(result.passed).toBe(1)
      expect(result.failed).toBe(1)
    })

    test("parses vitest output", () => {
      const output = `vitest v1.0.0

 ✓ src/utils.test.ts (3 tests) 12ms
   ✓ formatDate > works
   ✓ formatDate > handles null
   ✕ formatDate > handles undefined (5 ms)

Tests:  1 failed, 2 passed, 3 total`

      const result = TestParser.parse(output, "vitest")
      expect(result.framework).toBe("vitest")
      expect(result.passed).toBe(2)
      expect(result.failed).toBe(1)
    })

    test("parses skip markers", () => {
      const output = `PASS src/foo.test.ts
  describe
    ✓ works (2 ms)
    ○ skipped test

Tests: 1 passed, 1 total`

      const result = TestParser.parse(output, "jest")
      expect(result.skipped).toBe(1)
    })
  })

  describe("pytest format", () => {
    test("parses PASSED/FAILED markers", () => {
      const output = `============================= test session starts ==============================
collected 3 items

tests/test_math.py::test_add PASSED
tests/test_math.py::test_subtract PASSED
tests/test_math.py::test_divide FAILED

FAILED tests/test_math.py::test_divide - ZeroDivisionError: division by zero

========================= 1 failed, 2 passed in 0.12s =========================`

      const result = TestParser.parse(output, "pytest")
      expect(result.framework).toBe("pytest")
      expect(result.passed).toBe(2)
      expect(result.failed).toBe(1)

      const failure = result.results.find((r) => r.status === "fail")
      expect(failure).toBeDefined()
      expect(failure!.name).toBe("test_divide")
      expect(failure!.file).toBe("tests/test_math.py")
    })

    test("parses ERROR tests", () => {
      const output = `ERROR tests/test_broken.py::test_setup - ImportError: No module named 'foo'`

      const result = TestParser.parse(output, "pytest")
      expect(result.errors).toBe(1)
    })

    test("parses SKIPPED tests", () => {
      const output = `tests/test_slow.py::test_integration PASSED
SKIPPED tests/test_slow.py::test_heavy`

      const result = TestParser.parse(output, "pytest")
      expect(result.skipped).toBe(1)
      expect(result.passed).toBe(1)
    })
  })

  describe("go test format", () => {
    test("parses PASS/FAIL results", () => {
      const output = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSubtract
--- PASS: TestSubtract (0.01s)
=== RUN   TestDivide
--- FAIL: TestDivide (0.00s)
    math_test.go:25: expected 5, got 0
FAIL
FAIL	example.com/math	0.123s`

      const result = TestParser.parse(output, "go")
      expect(result.framework).toBe("go")
      expect(result.passed).toBe(2)
      expect(result.failed).toBe(1)
      expect(result.duration).toBe(123)

      const failure = result.results.find((r) => r.status === "fail")
      expect(failure!.name).toBe("TestDivide")
    })

    test("parses SKIP results", () => {
      const output = `=== RUN   TestSlow
--- SKIP: TestSlow (0.00s)
ok	example.com/math	0.001s`

      const result = TestParser.parse(output, "go")
      expect(result.skipped).toBe(1)
    })

    test("extracts duration from ok line", () => {
      const output = `=== RUN   TestFoo
--- PASS: TestFoo (0.01s)
ok	example.com/pkg	1.234s`

      const result = TestParser.parse(output, "go")
      expect(result.duration).toBe(1234)
    })
  })

  describe("format", () => {
    test("formats all-pass summary", () => {
      const summary: TestParser.TestSummary = {
        framework: "bun",
        total: 5,
        passed: 5,
        failed: 0,
        skipped: 0,
        errors: 0,
        results: Array.from({ length: 5 }, (_, i) => ({
          name: `test ${i}`,
          status: "pass" as const,
        })),
      }

      const output = TestParser.format(summary)
      expect(output).toContain("All 5 tests passed")
    })

    test("formats failures with details", () => {
      const summary: TestParser.TestSummary = {
        framework: "bun",
        total: 3,
        passed: 1,
        failed: 2,
        skipped: 0,
        errors: 0,
        results: [
          { name: "test 1", status: "pass" },
          {
            name: "test 2",
            status: "fail",
            file: "src/math.test.ts",
            line: 15,
            assertion: { expected: "3", received: "-3", operator: "toBe" },
          },
          {
            name: "test 3",
            status: "fail",
            assertion: { message: "Timeout exceeded" },
          },
        ],
      }

      const output = TestParser.format(summary)
      expect(output).toContain("2 of 3 test(s) failed")
      expect(output).toContain("FAIL src/math.test.ts:15")
      expect(output).toContain("Expected: 3")
      expect(output).toContain("Received: -3")
      expect(output).toContain("Timeout exceeded")
      expect(output).toContain("1 test(s) passed")
    })

    test("respects maxResults limit", () => {
      const results: TestParser.TestResult[] = Array.from({ length: 30 }, (_, i) => ({
        name: `test ${i}`,
        status: "fail" as const,
      }))

      const summary: TestParser.TestSummary = {
        framework: "bun",
        total: 30,
        passed: 0,
        failed: 30,
        skipped: 0,
        errors: 0,
        results,
      }

      const output = TestParser.format(summary, 5)
      expect(output).toContain("... and 25 more failure(s)")
    })

    test("shows skipped count", () => {
      const summary: TestParser.TestSummary = {
        framework: "bun",
        total: 5,
        passed: 3,
        failed: 1,
        skipped: 1,
        errors: 0,
        results: [
          { name: "t1", status: "pass" },
          { name: "t2", status: "pass" },
          { name: "t3", status: "pass" },
          { name: "t4", status: "fail" },
          { name: "t5", status: "skip" },
        ],
      }

      const output = TestParser.format(summary)
      expect(output).toContain("1 test(s) skipped")
    })
  })

  describe("auto-detection", () => {
    test("detects bun test output", () => {
      const result = TestParser.parse("bun test v1.3.10\n\n 1 pass\n 0 fail")
      expect(result.framework).toBe("bun")
    })

    test("detects pytest output", () => {
      const result = TestParser.parse("============================= test session starts ==============================\ncollected 1 item\n\ntests/test_foo.py::test_bar PASSED")
      expect(result.framework).toBe("pytest")
    })

    test("detects go test output", () => {
      const result = TestParser.parse("=== RUN   TestFoo\n--- PASS: TestFoo (0.00s)\nok\texample.com/pkg\t0.001s")
      expect(result.framework).toBe("go")
    })
  })
})
