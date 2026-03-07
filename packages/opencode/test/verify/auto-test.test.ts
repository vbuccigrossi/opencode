import { describe, test, expect, beforeEach } from "bun:test"
import { AutoTest } from "../../src/verify/auto-test"
import { Graph } from "../../src/graph"
import path from "path"
import fs from "fs"
import os from "os"

describe("AutoTest", () => {
  describe("discoverTests", () => {
    test("returns empty for empty input", () => {
      const result = AutoTest.discoverTests([])
      expect(result.testFiles).toEqual([])
      expect(result.method).toBe("none")
    })

    test("filters out test files from changed files", () => {
      // If all changed files are test files, nothing to discover
      const result = AutoTest.discoverTests([
        "/project/test/foo.test.ts",
        "/project/__tests__/bar.spec.ts",
      ])
      expect(result.testFiles).toEqual([])
      expect(result.method).toBe("none")
    })

    test("discovers tests via convention for .test.ts pattern", () => {
      // Create a temp directory with source + test files
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-"))
      const srcFile = path.join(tmpDir, "utils.ts")
      const testFile = path.join(tmpDir, "utils.test.ts")

      fs.writeFileSync(srcFile, "export function add(a: number, b: number) { return a + b }")
      fs.writeFileSync(testFile, "import { add } from './utils'; test('add', () => expect(add(1,2)).toBe(3))")

      try {
        const result = AutoTest.discoverTests([srcFile])
        expect(result.testFiles).toContain(testFile)
        expect(result.method).toBe("convention")
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test("discovers tests via convention for .spec.ts pattern", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-"))
      const srcFile = path.join(tmpDir, "handler.ts")
      const specFile = path.join(tmpDir, "handler.spec.ts")

      fs.writeFileSync(srcFile, "export function handle() {}")
      fs.writeFileSync(specFile, "describe('handler', () => {})")

      try {
        const result = AutoTest.discoverTests([srcFile])
        expect(result.testFiles).toContain(specFile)
        expect(result.method).toBe("convention")
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test("discovers tests in parent test/ directory", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-"))
      const srcDir = path.join(tmpDir, "src")
      const testDir = path.join(tmpDir, "test")

      fs.mkdirSync(srcDir, { recursive: true })
      fs.mkdirSync(testDir, { recursive: true })

      const srcFile = path.join(srcDir, "parser.ts")
      const testFile = path.join(testDir, "parser.test.ts")

      fs.writeFileSync(srcFile, "export function parse() {}")
      fs.writeFileSync(testFile, "describe('parser', () => {})")

      try {
        const result = AutoTest.discoverTests([srcFile])
        expect(result.testFiles).toContain(testFile)
        expect(result.method).toBe("convention")
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test("limits discovered tests to MAX_TEST_FILES", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-"))
      const sourceFiles: string[] = []

      // Create 10 source files with matching test files
      for (let i = 0; i < 10; i++) {
        const src = path.join(tmpDir, `mod${i}.ts`)
        const tst = path.join(tmpDir, `mod${i}.test.ts`)
        fs.writeFileSync(src, `export const x${i} = ${i}`)
        fs.writeFileSync(tst, `test('mod${i}', () => {})`)
        sourceFiles.push(src)
      }

      try {
        const result = AutoTest.discoverTests(sourceFiles)
        // Should be capped at 5 (MAX_TEST_FILES)
        expect(result.testFiles.length).toBeLessThanOrEqual(5)
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test("handles non-existent source files gracefully", () => {
      const result = AutoTest.discoverTests(["/nonexistent/path/foo.ts"])
      // Should not throw, just find no tests
      expect(result.testFiles).toEqual([])
    })
  })

  describe("formatErrors", () => {
    test("formats test failures into error block", () => {
      const result: AutoTest.AutoTestResult = {
        success: false,
        testFiles: ["/project/test/foo.test.ts"],
        passed: 0,
        failed: 1,
        errors: [
          {
            file: "/project/test/foo.test.ts",
            line: 10,
            column: undefined,
            severity: "error",
            message: "Expected 3 but got 4",
            code: undefined,
          },
        ],
        discoveryMethod: "graph",
      }

      const formatted = AutoTest.formatErrors(result, 2)
      expect(formatted).toContain("<auto-test-errors>")
      expect(formatted).toContain("</auto-test-errors>")
      expect(formatted).toContain("1 failure(s)")
      expect(formatted).toContain("Expected 3 but got 4")
      expect(formatted).toContain("foo.test.ts")
      expect(formatted).toContain("2 automatic repair attempt")
    })

    test("formats last attempt message", () => {
      const result: AutoTest.AutoTestResult = {
        success: false,
        testFiles: ["/project/test/bar.test.ts"],
        passed: 0,
        failed: 1,
        errors: [],
        discoveryMethod: "convention",
      }

      const formatted = AutoTest.formatErrors(result, 0)
      expect(formatted).toContain("last automatic repair attempt")
    })

    test("truncates many errors", () => {
      const errors = Array.from({ length: 15 }, (_, i) => ({
        file: `/project/test/file${i}.ts`,
        line: i + 1,
        column: undefined,
        severity: "error" as const,
        message: `Error ${i}`,
        code: undefined,
      }))

      const result: AutoTest.AutoTestResult = {
        success: false,
        testFiles: ["/project/test/big.test.ts"],
        passed: 0,
        failed: 1,
        errors,
        discoveryMethod: "graph",
      }

      const formatted = AutoTest.formatErrors(result, 1)
      expect(formatted).toContain("5 more error(s)")
    })
  })

  describe("runTests", () => {
    test("returns success for empty test files", async () => {
      const result = await AutoTest.runTests([])
      expect(result.success).toBe(true)
      expect(result.testFiles).toEqual([])
      expect(result.discoveryMethod).toBe("none")
    })
  })
})
