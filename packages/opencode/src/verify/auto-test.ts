import { Graph } from "@/graph"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Verify } from "."
import { VerifyEngine } from "./engine"
import { VerifyDetect } from "./detect"

/**
 * Auto-test discovery and execution — finds and runs tests relevant to
 * edited files using the knowledge graph's `tested_by` edges.
 *
 * Called by the verify loop after typecheck passes. Discovers test files
 * for changed source files and runs them with tight timeouts.
 */
export namespace AutoTest {
  const log = Log.create({ service: "verify.auto-test" })

  /** Maximum test files to run per verification cycle. */
  const MAX_TEST_FILES = 5

  /** Timeout per test file in milliseconds. */
  const TEST_TIMEOUT = 30_000

  /** Result of auto-test execution. */
  export interface AutoTestResult {
    /** Whether all discovered tests passed. */
    success: boolean
    /** Test files that were discovered and run. */
    testFiles: string[]
    /** Number of tests that passed. */
    passed: number
    /** Number of tests that failed. */
    failed: number
    /** Structured errors from failed tests. */
    errors: VerifyEngine.VerifyError[]
    /** How test files were discovered. */
    discoveryMethod: "graph" | "convention" | "none"
  }

  /**
   * Discover test files related to the given changed source files.
   *
   * Uses two strategies:
   * 1. Graph `tested_by` edges — most precise, uses import analysis
   * 2. Convention matching — looks for co-located .test/.spec files
   *
   * @param changedFiles - Files that were modified
   * @returns Array of test file paths and the discovery method used
   */
  export function discoverTests(changedFiles: string[]): {
    testFiles: string[]
    method: "graph" | "convention" | "none"
  } {
    // Filter out test files from changed files — we only want source file changes
    const sourceFiles = changedFiles.filter((f) => !Graph.isTestFile(f))
    if (sourceFiles.length === 0) {
      return { testFiles: [], method: "none" }
    }

    // Strategy 1: Graph-based discovery via tested_by edges
    const graphTests = discoverViaGraph(sourceFiles)
    if (graphTests.length > 0) {
      return {
        testFiles: graphTests.slice(0, MAX_TEST_FILES),
        method: "graph",
      }
    }

    // Strategy 2: Convention-based discovery
    const conventionTests = discoverViaConvention(sourceFiles)
    if (conventionTests.length > 0) {
      return {
        testFiles: conventionTests.slice(0, MAX_TEST_FILES),
        method: "convention",
      }
    }

    return { testFiles: [], method: "none" }
  }

  /**
   * Run discovered test files and return structured results.
   *
   * @param testFiles - Test files to run
   * @returns Structured test results
   */
  export async function runTests(testFiles: string[]): Promise<AutoTestResult> {
    if (testFiles.length === 0) {
      return {
        success: true,
        testFiles: [],
        passed: 0,
        failed: 0,
        errors: [],
        discoveryMethod: "none",
      }
    }

    log.info("running auto-tests", { testFiles, count: testFiles.length })

    const errors: VerifyEngine.VerifyError[] = []
    let passed = 0
    let failed = 0

    // Run tests via the verify engine with file targeting
    try {
      const result = await Verify.run({
        typecheck: false,
        lint: false,
        test: true,
        build: false,
        timeout: TEST_TIMEOUT,
        files: testFiles,
        targeted: true,
      })

      const testStep = result.steps.find((s) => s.step === "test")
      if (testStep) {
        if (testStep.success) {
          passed = testFiles.length
        } else {
          failed = testFiles.length
          for (const err of testStep.errors) {
            errors.push(err)
          }
        }
      } else {
        // No test step means no test runner detected
        log.info("no test step in verification result, skipping")
        return {
          success: true,
          testFiles,
          passed: 0,
          failed: 0,
          errors: [],
          discoveryMethod: "none",
        }
      }
    } catch (err: any) {
      log.warn("auto-test execution failed", { error: err.message })
      failed = testFiles.length
      for (const testFile of testFiles) {
        errors.push({
          file: testFile,
          line: undefined,
          column: undefined,
          severity: "error",
          message: `Test execution failed: ${err.message}`,
          code: undefined,
        })
      }
    }

    return {
      success: failed === 0,
      testFiles,
      passed,
      failed,
      errors,
      discoveryMethod: "graph",
    }
  }

  /**
   * Format auto-test failures into a verification error block.
   *
   * @param result - Auto-test result
   * @param remainingAttempts - How many repair attempts remain
   * @returns Formatted error block for injection
   */
  export function formatErrors(result: AutoTestResult, remainingAttempts: number): string {
    const sections: string[] = []

    sections.push("<auto-test-errors>")
    sections.push(`Automatic tests detected ${result.failed} failure(s) after your edits.`)
    sections.push(`Test files run: ${result.testFiles.join(", ")}`)
    sections.push(`Discovery method: ${result.discoveryMethod}`)
    sections.push("")

    const displayErrors = result.errors.slice(0, 10)
    for (const err of displayErrors) {
      const loc = err.file
        ? `${err.file}${err.line ? `:${err.line}` : ""}`
        : "(unknown)"
      sections.push(`  ${loc}: ${err.message}`)
    }

    if (result.errors.length > 10) {
      sections.push(`  ... and ${result.errors.length - 10} more error(s)`)
    }

    sections.push("")
    if (remainingAttempts > 0) {
      sections.push(
        `Please fix the failing tests. You have ${remainingAttempts} automatic repair attempt${remainingAttempts !== 1 ? "s" : ""} remaining.`,
      )
    } else {
      sections.push(
        "This is your last automatic repair attempt. Fix the test failures or inform the user.",
      )
    }

    sections.push("</auto-test-errors>")
    return sections.join("\n")
  }

  // ─── Internal Discovery ────────────────────────────────────────

  /**
   * Discover tests via graph `tested_by` edges.
   * Queries the knowledge graph for each changed file's nodes.
   */
  function discoverViaGraph(sourceFiles: string[]): string[] {
    const testFiles = new Set<string>()

    try {
      const projectID = Instance.project.id

      for (const file of sourceFiles) {
        // Get all entities defined in this file
        const nodes = Graph.nodesInFile(projectID, file)

        for (const node of nodes.slice(0, 15)) {
          // Check impact — affectedFiles includes test files
          try {
            const impact = Graph.impactOf(projectID, node.name, 1)
            for (const affected of impact.affectedFiles) {
              if (Graph.isTestFile(affected)) {
                testFiles.add(affected)
              }
            }
          } catch {
            // Individual node lookup may fail — continue
          }
        }

        // Also check callers — if a test file imports this file's symbols,
        // those callers will appear as callers of the file's nodes
        for (const node of nodes.slice(0, 5)) {
          try {
            const callers = Graph.callersOf(projectID, node.name)
            for (const caller of callers) {
              if (caller.filePath && Graph.isTestFile(caller.filePath)) {
                testFiles.add(caller.filePath)
              }
            }
          } catch {
            // Caller lookup may fail — continue
          }
        }
      }
    } catch {
      // Graph not available
    }

    return [...testFiles]
  }

  /**
   * Discover tests via naming convention.
   * Looks for co-located test files with common patterns.
   */
  function discoverViaConvention(sourceFiles: string[]): string[] {
    const testFiles: string[] = []
    const fs = require("fs")

    for (const file of sourceFiles) {
      const dir = require("path").dirname(file)
      const base = require("path").basename(file)
      const ext = require("path").extname(file)
      const name = base.slice(0, -ext.length)

      // Common test file patterns
      const candidates = [
        // Co-located: foo.test.ts, foo.spec.ts
        require("path").join(dir, `${name}.test${ext}`),
        require("path").join(dir, `${name}.spec${ext}`),
        // Test directory: test/foo.test.ts, __tests__/foo.test.ts
        require("path").join(dir, "..", "test", `${name}.test${ext}`),
        require("path").join(dir, "..", "tests", `${name}.test${ext}`),
        require("path").join(dir, "__tests__", `${name}.test${ext}`),
        // Go convention: foo_test.go
        require("path").join(dir, `${name}_test${ext}`),
        // Python convention: test_foo.py
        require("path").join(dir, `test_${name}${ext}`),
      ]

      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) {
            testFiles.push(candidate)
            break // one test file per source file is enough
          }
        } catch {
          // File doesn't exist — continue
        }
      }
    }

    return testFiles
  }
}
