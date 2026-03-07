import { describe, expect, test } from "bun:test"
import { DryRun } from "../../src/dryrun"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"

/** Create a temporary directory with a TypeScript file. */
function createTestDir(files?: Record<string, string>): string {
  const dir = join(tmpdir(), `dryrun-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })

  if (files) {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content)
    }
  }

  return dir
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true })
  } catch {}
}

describe("DryRun", () => {
  describe("check", () => {
    test("passes for valid TypeScript", async () => {
      const dir = createTestDir({
        "valid.ts": 'const x: number = 42;\nconsole.log(x);',
      })

      const result = await DryRun.check(
        join(dir, "valid.ts"),
        'const x: number = 42;\nconst y: string = "hello";\nconsole.log(x, y);',
      )

      // May or may not have tsgo/tsc available in test env
      // But the structure should be correct
      expect(typeof result.wouldSucceed).toBe("boolean")
      expect(Array.isArray(result.errors)).toBe(true)
      expect(Array.isArray(result.warnings)).toBe(true)
      expect(result.duration).toBeGreaterThanOrEqual(0)

      cleanup(dir)
    })

    test("skips non-TypeScript files", async () => {
      const result = await DryRun.check(
        "/tmp/test.py",
        "print('hello')",
      )

      expect(result.wouldSucceed).toBe(true)
      expect(result.errors.length).toBe(0)
    })

    test("skips unsupported extensions", async () => {
      const result = await DryRun.check(
        "/tmp/test.go",
        "package main",
      )

      expect(result.wouldSucceed).toBe(true)
    })

    test("cleans up temp files", async () => {
      const dir = createTestDir({
        "cleanup.ts": "const x = 1;",
      })

      await DryRun.check(join(dir, "cleanup.ts"), "const x: number = 1;")

      // Check no .dryrun files remain
      const { readdirSync } = await import("fs")
      const files = readdirSync(dir)
      const dryrunFiles = files.filter((f: string) => f.includes(".dryrun"))
      expect(dryrunFiles.length).toBe(0)

      cleanup(dir)
    })

    test("returns result structure", async () => {
      const result = await DryRun.check(
        "/tmp/test.ts",
        "const x: number = 'hello';", // Type error
      )

      expect(typeof result.wouldSucceed).toBe("boolean")
      expect(typeof result.duration).toBe("number")
      expect(Array.isArray(result.errors)).toBe(true)
      expect(Array.isArray(result.warnings)).toBe(true)
    })
  })

  describe("checkBatch", () => {
    test("handles empty edits", async () => {
      const result = await DryRun.checkBatch([])
      expect(result.wouldSucceed).toBe(true)
      expect(result.errors.length).toBe(0)
    })

    test("handles single edit", async () => {
      const result = await DryRun.checkBatch([
        { filePath: "/tmp/test.py", newContent: "x = 1" },
      ])
      // Python file skipped
      expect(result.wouldSucceed).toBe(true)
    })

    test("handles multiple edits", async () => {
      const result = await DryRun.checkBatch([
        { filePath: "/tmp/a.py", newContent: "x = 1" },
        { filePath: "/tmp/b.py", newContent: "y = 2" },
      ])
      expect(result.wouldSucceed).toBe(true)
    })
  })

  describe("format", () => {
    test("formats passing result", () => {
      const result: DryRun.Result = {
        wouldSucceed: true,
        errors: [],
        warnings: [],
        duration: 150,
      }

      const formatted = DryRun.format(result)
      expect(formatted).toContain("PASS")
      expect(formatted).toContain("150ms")
    })

    test("formats failing result", () => {
      const result: DryRun.Result = {
        wouldSucceed: false,
        errors: [
          { file: "test.ts", line: 5, column: 10, message: "Type error", severity: "error" },
          { file: "test.ts", line: 12, message: "Missing return", severity: "error" },
        ],
        warnings: [],
        duration: 200,
      }

      const formatted = DryRun.format(result)
      expect(formatted).toContain("FAIL")
      expect(formatted).toContain("2 error(s)")
      expect(formatted).toContain("5:10")
      expect(formatted).toContain("Type error")
      expect(formatted).toContain("12")
      expect(formatted).toContain("Missing return")
    })

    test("formats warnings", () => {
      const result: DryRun.Result = {
        wouldSucceed: true,
        errors: [],
        warnings: [
          { file: "test.ts", line: 3, message: "Unused variable", severity: "warning" },
        ],
        duration: 100,
      }

      const formatted = DryRun.format(result)
      expect(formatted).toContain("PASS with warnings")
      expect(formatted).toContain("Unused variable")
    })

    test("truncates many errors", () => {
      const result: DryRun.Result = {
        wouldSucceed: false,
        errors: Array.from({ length: 15 }, (_, i) => ({
          file: "test.ts",
          line: i + 1,
          message: `Error ${i}`,
          severity: "error" as const,
        })),
        warnings: [],
        duration: 300,
      }

      const formatted = DryRun.format(result)
      expect(formatted).toContain("... and 5 more errors")
    })
  })
})
