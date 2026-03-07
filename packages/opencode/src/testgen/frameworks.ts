import { Log } from "@/util/log"
import { access } from "fs/promises"
import { join } from "path"

/**
 * Test framework detection and template generation.
 *
 * Detects the test framework used by a project and generates
 * test code matching the project's conventions.
 */
export namespace Frameworks {
  const log = Log.create({ service: "testgen.frameworks" })

  /** Supported test frameworks. */
  export type Framework = "bun_test" | "vitest" | "jest" | "mocha" | "pytest" | "go_test"

  /** Template for a test file. */
  export interface Template {
    /** Import statement. */
    imports: string
    /** Describe block opener. */
    describeOpen: (name: string) => string
    /** Describe block closer. */
    describeClose: string
    /** Test case wrapper. */
    testCase: (name: string, body: string) => string
    /** Assertion: expect equal. */
    assertEqual: (actual: string, expected: string) => string
    /** Assertion: expect truthy. */
    assertTruthy: (expr: string) => string
    /** Assertion: expect throws. */
    assertThrows: (expr: string) => string
    /** File extension for test files. */
    extension: string
    /** Test file naming convention. */
    testFileName: (sourceFile: string) => string
  }

  /**
   * Detect the test framework used by a project.
   *
   * Checks for framework-specific config files and dependencies.
   *
   * @param cwd - Project root directory
   * @returns Detected framework name
   */
  export async function detect(cwd: string): Promise<Framework> {
    // Check for bun test (bun.lockb or bun.lock)
    try {
      await access(join(cwd, "bun.lock"))
      return "bun_test"
    } catch {}
    try {
      await access(join(cwd, "bun.lockb"))
      return "bun_test"
    } catch {}

    // Check package.json for test deps
    try {
      const { readFile } = await import("fs/promises")
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }

      if (deps.vitest) return "vitest"
      if (deps.jest || deps["ts-jest"]) return "jest"
      if (deps.mocha) return "mocha"
    } catch {}

    // Check for Go
    try {
      await access(join(cwd, "go.mod"))
      return "go_test"
    } catch {}

    // Check for Python
    try {
      await access(join(cwd, "pyproject.toml"))
      return "pytest"
    } catch {}
    try {
      await access(join(cwd, "requirements.txt"))
      return "pytest"
    } catch {}

    // Default to bun_test for TypeScript projects
    return "bun_test"
  }

  /**
   * Get the test template for a framework.
   *
   * @param framework - The test framework
   * @returns Template with imports, assertions, and structure
   */
  export function template(framework: Framework): Template {
    switch (framework) {
      case "bun_test":
        return bunTestTemplate()
      case "vitest":
        return vitestTemplate()
      case "jest":
        return jestTemplate()
      case "mocha":
        return mochaTemplate()
      case "pytest":
        return pytestTemplate()
      case "go_test":
        return goTestTemplate()
      default:
        return bunTestTemplate()
    }
  }

  // ─── Templates ────────────────────────────────────────────────

  function bunTestTemplate(): Template {
    return {
      imports: 'import { describe, expect, test } from "bun:test"',
      describeOpen: (name) => `describe("${name}", () => {`,
      describeClose: "})",
      testCase: (name, body) => `  test("${name}", () => {\n${body}\n  })`,
      assertEqual: (actual, expected) => `    expect(${actual}).toEqual(${expected})`,
      assertTruthy: (expr) => `    expect(${expr}).toBeTruthy()`,
      assertThrows: (expr) => `    expect(() => ${expr}).toThrow()`,
      extension: ".test.ts",
      testFileName: (f) => f.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1"),
    }
  }

  function vitestTemplate(): Template {
    return {
      imports: 'import { describe, expect, it } from "vitest"',
      describeOpen: (name) => `describe("${name}", () => {`,
      describeClose: "})",
      testCase: (name, body) => `  it("${name}", () => {\n${body}\n  })`,
      assertEqual: (actual, expected) => `    expect(${actual}).toEqual(${expected})`,
      assertTruthy: (expr) => `    expect(${expr}).toBeTruthy()`,
      assertThrows: (expr) => `    expect(() => ${expr}).toThrow()`,
      extension: ".test.ts",
      testFileName: (f) => f.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1"),
    }
  }

  function jestTemplate(): Template {
    return {
      imports: "",
      describeOpen: (name) => `describe("${name}", () => {`,
      describeClose: "})",
      testCase: (name, body) => `  it("${name}", () => {\n${body}\n  })`,
      assertEqual: (actual, expected) => `    expect(${actual}).toEqual(${expected})`,
      assertTruthy: (expr) => `    expect(${expr}).toBeTruthy()`,
      assertThrows: (expr) => `    expect(() => ${expr}).toThrow()`,
      extension: ".test.ts",
      testFileName: (f) => f.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1"),
    }
  }

  function mochaTemplate(): Template {
    return {
      imports: 'import { expect } from "chai"',
      describeOpen: (name) => `describe("${name}", () => {`,
      describeClose: "})",
      testCase: (name, body) => `  it("${name}", () => {\n${body}\n  })`,
      assertEqual: (actual, expected) => `    expect(${actual}).to.equal(${expected})`,
      assertTruthy: (expr) => `    expect(${expr}).to.be.ok`,
      assertThrows: (expr) => `    expect(() => ${expr}).to.throw()`,
      extension: ".test.ts",
      testFileName: (f) => f.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1"),
    }
  }

  function pytestTemplate(): Template {
    return {
      imports: "import pytest",
      describeOpen: (name) => `class Test${name}:`,
      describeClose: "",
      testCase: (name, body) => `    def test_${name.replace(/\s+/g, "_").toLowerCase()}(self):\n${body}`,
      assertEqual: (actual, expected) => `        assert ${actual} == ${expected}`,
      assertTruthy: (expr) => `        assert ${expr}`,
      assertThrows: (expr) => `        with pytest.raises(Exception):\n            ${expr}`,
      extension: "_test.py",
      testFileName: (f) => f.replace(/\.py$/, "_test.py"),
    }
  }

  function goTestTemplate(): Template {
    return {
      imports: 'import "testing"',
      describeOpen: (name) => `func Test${name}(t *testing.T) {`,
      describeClose: "}",
      testCase: (name, body) => `  t.Run("${name}", func(t *testing.T) {\n${body}\n  })`,
      assertEqual: (actual, expected) => `    if ${actual} != ${expected} {\n      t.Errorf("expected %v, got %v", ${expected}, ${actual})\n    }`,
      assertTruthy: (expr) => `    if !${expr} {\n      t.Error("expected truthy")\n    }`,
      assertThrows: () => `    // Expect panic\n    defer func() { recover() }()`,
      extension: "_test.go",
      testFileName: (f) => f.replace(/\.go$/, "_test.go"),
    }
  }
}
