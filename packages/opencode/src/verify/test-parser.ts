import { Log } from "@/util/log"

/**
 * Structured test result parser — understands the output format of
 * major test runners and extracts structured results.
 *
 * Instead of reading raw test output, the agent gets:
 * - Which tests passed/failed
 * - Exact assertion details (expected vs received)
 * - Source file and line number
 * - Duration per test
 */
export namespace TestParser {
  const log = Log.create({ service: "verify.test-parser" })

  /** Supported test framework output formats. */
  export type Framework = "bun" | "jest" | "vitest" | "pytest" | "go"

  /** A single assertion failure detail. */
  export interface AssertionDetail {
    expected?: string
    received?: string
    operator?: string
    message?: string
  }

  /** A single test result. */
  export interface TestResult {
    /** Full test name (describe > test). */
    name: string
    /** Test status. */
    status: "pass" | "fail" | "error" | "skip"
    /** Duration in ms. */
    duration?: number
    /** Test file path. */
    file?: string
    /** Failure line number. */
    line?: number
    /** Assertion details for failures. */
    assertion?: AssertionDetail
  }

  /** Parsed test suite summary. */
  export interface TestSummary {
    framework: Framework
    total: number
    passed: number
    failed: number
    skipped: number
    errors: number
    duration?: number
    results: TestResult[]
  }

  /**
   * Parse test output and extract structured results.
   *
   * Auto-detects the framework from the output format.
   *
   * @param output - Raw test command output
   * @param hint - Optional framework hint
   * @returns Structured test summary
   */
  export function parse(output: string, hint?: Framework): TestSummary {
    const framework = hint ?? detectFramework(output)

    switch (framework) {
      case "bun":
        return parseBun(output)
      case "jest":
      case "vitest":
        return parseJest(output, framework)
      case "pytest":
        return parsePytest(output)
      case "go":
        return parseGo(output)
      default:
        return parseBun(output) // Fallback
    }
  }

  /**
   * Format test results for agent consumption.
   *
   * Shows only failures in detail, with a summary line for passes.
   *
   * @param summary - Parsed test summary
   * @param maxResults - Maximum individual results to show (default: 20)
   * @returns Formatted string
   */
  export function format(summary: TestSummary, maxResults: number = 20): string {
    const lines: string[] = []

    // Summary line
    if (summary.failed === 0 && summary.errors === 0) {
      lines.push(`All ${summary.total} tests passed.`)
      if (summary.duration) lines.push(`Duration: ${summary.duration}ms`)
      return lines.join("\n")
    }

    const failCount = summary.failed + summary.errors
    lines.push(`${failCount} of ${summary.total} test(s) failed:`)
    lines.push("")

    // Show failures in detail
    const failures = summary.results
      .filter((r) => r.status === "fail" || r.status === "error")
      .slice(0, maxResults)

    for (const result of failures) {
      const filePart = result.file ? ` ${result.file}` : ""
      const linePart = result.line ? `:${result.line}` : ""
      lines.push(`FAIL${filePart}${linePart} > ${result.name}`)

      if (result.assertion) {
        if (result.assertion.message) {
          lines.push(`  ${result.assertion.message}`)
        }
        if (result.assertion.expected !== undefined) {
          lines.push(`  Expected: ${result.assertion.expected}`)
        }
        if (result.assertion.received !== undefined) {
          lines.push(`  Received: ${result.assertion.received}`)
        }
      }
      lines.push("")
    }

    if (summary.failed + summary.errors > maxResults) {
      lines.push(`... and ${summary.failed + summary.errors - maxResults} more failure(s)`)
    }

    // Passes summary
    if (summary.passed > 0) {
      lines.push(`${summary.passed} test(s) passed.`)
    }
    if (summary.skipped > 0) {
      lines.push(`${summary.skipped} test(s) skipped.`)
    }

    return lines.join("\n")
  }

  // ─── Framework Detection ──────────────────────────────────────

  /** Detect framework from output. */
  function detectFramework(output: string): Framework {
    if (/bun test v/.test(output)) return "bun"
    if (/PASS|FAIL.*\.test\.\w+/.test(output) && /Tests:/.test(output)) return "jest"
    if (/\bvitest\b/i.test(output)) return "vitest"
    if (/={3,}\s*(test session starts|FAILURES)/.test(output)) return "pytest"
    if (/=== RUN/.test(output) && /--- (PASS|FAIL):/.test(output)) return "go"

    return "bun" // Default fallback
  }

  // ─── Bun Parser ───────────────────────────────────────────────

  function parseBun(output: string): TestSummary {
    const results: TestResult[] = []
    const lines = output.split("\n")
    let currentFile = ""
    let currentDescribe = ""

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // File header: test/foo.test.ts:
      const fileMatch = trimmed.match(/^(\S+\.(?:test|spec)\.\w+):$/)
      if (fileMatch) {
        currentFile = fileMatch[1]
        currentDescribe = ""
        continue
      }

      // Pass: (pass) test name [duration]
      const passMatch = trimmed.match(/^\(pass\)\s+(.+?)(?:\s+\[[\d.]+(?:ms|s)\])?$/)
      if (passMatch) {
        const name = currentDescribe ? `${currentDescribe} > ${passMatch[1]}` : passMatch[1]
        const durMatch = trimmed.match(/\[([\d.]+)(ms|s)\]/)
        results.push({
          name,
          status: "pass",
          file: currentFile || undefined,
          duration: durMatch ? parseDuration(durMatch[1], durMatch[2]) : undefined,
        })
        continue
      }

      // Fail: (fail) test name [duration]
      const failMatch = trimmed.match(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+(?:ms|s)\])?$/)
      if (failMatch) {
        const name = currentDescribe ? `${currentDescribe} > ${failMatch[1]}` : failMatch[1]
        const durMatch = trimmed.match(/\[([\d.]+)(ms|s)\]/)
        const assertion = extractBunAssertion(lines, i)
        results.push({
          name,
          status: "fail",
          file: currentFile || undefined,
          duration: durMatch ? parseDuration(durMatch[1], durMatch[2]) : undefined,
          assertion,
          line: extractLineNumber(lines, i),
        })
        continue
      }

      // Skip: (skip) test name
      const skipMatch = trimmed.match(/^\(skip\)\s+(.+)$/)
      if (skipMatch) {
        results.push({
          name: currentDescribe ? `${currentDescribe} > ${skipMatch[1]}` : skipMatch[1],
          status: "skip",
          file: currentFile || undefined,
        })
        continue
      }

      // Describe block detection (indentation-based in bun output)
      if (trimmed && !trimmed.startsWith("(") && !trimmed.startsWith("error") && !trimmed.startsWith("expect")) {
        // Might be a describe label — check if next lines are test results
        const next = lines[i + 1]?.trim() ?? ""
        if (next.startsWith("(pass)") || next.startsWith("(fail)") || next.startsWith("(skip)")) {
          currentDescribe = trimmed
        }
      }
    }

    // Parse summary line: X pass, Y fail, Z expect() calls
    const summaryMatch = output.match(/(\d+)\s+pass/)
    const failSummary = output.match(/(\d+)\s+fail/)
    const durationMatch = output.match(/\[([\d.]+(?:ms|s))\]$/)

    return {
      framework: "bun",
      total: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    }
  }

  /** Extract assertion details from bun test output near a failure. */
  function extractBunAssertion(lines: string[], failLineIdx: number): AssertionDetail | undefined {
    // Look ahead for error: expect(...) blocks
    for (let j = failLineIdx + 1; j < Math.min(failLineIdx + 15, lines.length); j++) {
      const line = lines[j].trim()

      const expectMatch = line.match(/^error:\s*expect\(received\)\.(\w+)\(expected\)/)
      if (expectMatch) {
        const assertion: AssertionDetail = { operator: expectMatch[1] }

        // Look for Expected/Received lines
        for (let k = j + 1; k < Math.min(j + 5, lines.length); k++) {
          const detail = lines[k].trim()
          const expMatch = detail.match(/^Expected:\s*(.+)/)
          if (expMatch) assertion.expected = expMatch[1]
          const recMatch = detail.match(/^Received:\s*(.+)/)
          if (recMatch) assertion.received = recMatch[1]
        }
        return assertion
      }

      // Generic assertion message
      const msgMatch = line.match(/^error:\s*(.+)/)
      if (msgMatch) {
        return { message: msgMatch[1] }
      }

      // Stop at next test
      if (line.startsWith("(pass)") || line.startsWith("(fail)") || line.startsWith("(skip)")) break
    }

    return undefined
  }

  // ─── Jest/Vitest Parser ───────────────────────────────────────

  function parseJest(output: string, framework: "jest" | "vitest"): TestSummary {
    const results: TestResult[] = []
    const lines = output.split("\n")
    let currentFile = ""

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // File markers: PASS src/foo.test.ts  or  FAIL src/foo.test.ts
      const fileMatch = trimmed.match(/^(PASS|FAIL)\s+(.+?\.\w+)/)
      if (fileMatch) {
        currentFile = fileMatch[2]
        continue
      }

      // Pass: ✓ test name (duration ms)  or  √ test name
      // Skip file summary lines like "✓ src/utils.test.ts (3 tests) 12ms"
      const passMatch = trimmed.match(/^[✓✔√]\s+(.+?)(?:\s+\((\d+)\s*ms\))?$/)
      if (passMatch && !passMatch[1].match(/\(\d+ tests?\)/)) {
        results.push({
          name: passMatch[1],
          status: "pass",
          file: currentFile || undefined,
          duration: passMatch[2] ? parseInt(passMatch[2], 10) : undefined,
        })
        continue
      }

      // Fail: ✕ test name (duration ms)  or  × test name
      const failMatch = trimmed.match(/^[✕✗×]\s+(.+?)(?:\s+\((\d+)\s*ms\))?$/)
      if (failMatch && !failMatch[1].match(/\(\d+ tests?\)/)) {
        const assertion = extractJestAssertion(lines, i)
        results.push({
          name: failMatch[1],
          status: "fail",
          file: currentFile || undefined,
          duration: failMatch[2] ? parseInt(failMatch[2], 10) : undefined,
          assertion,
        })
        continue
      }

      // Skip: ○ skipped test name
      const skipMatch = trimmed.match(/^[○◌]\s+(?:skipped\s+)?(.+)$/)
      if (skipMatch) {
        results.push({
          name: skipMatch[1],
          status: "skip",
          file: currentFile || undefined,
        })
        continue
      }
    }

    // Summary: Tests: X failed, Y passed, Z total
    const totalMatch = output.match(/Tests:\s+.*?(\d+)\s+total/)

    return {
      framework,
      total: results.length || (totalMatch ? parseInt(totalMatch[1], 10) : 0),
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    }
  }

  /** Extract assertion from Jest/Vitest error block. */
  function extractJestAssertion(lines: string[], failIdx: number): AssertionDetail | undefined {
    for (let j = failIdx + 1; j < Math.min(failIdx + 20, lines.length); j++) {
      const line = lines[j].trim()

      // expect(received).toBe(expected) pattern
      const expectMatch = line.match(/expect\(received\)\.(\w+)\(expected\)/)
      if (expectMatch) {
        const assertion: AssertionDetail = { operator: expectMatch[1] }
        for (let k = j + 1; k < Math.min(j + 5, lines.length); k++) {
          const detail = lines[k].trim()
          const expMatch = detail.match(/^Expected:\s*(.+)/)
          if (expMatch) assertion.expected = expMatch[1]
          const recMatch = detail.match(/^Received:\s*(.+)/)
          if (recMatch) assertion.received = recMatch[1]
        }
        return assertion
      }

      // Stop conditions
      if (line.startsWith("●") || line.match(/^[✓✔√✕✗×○◌]/)) break
    }
    return undefined
  }

  // ─── Pytest Parser ────────────────────────────────────────────

  function parsePytest(output: string): TestSummary {
    const results: TestResult[] = []
    const lines = output.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()

      // PASSED test_file.py::test_name
      const passMatch = trimmed.match(/^(.+\.py)::(\S+)\s+PASSED/)
      if (passMatch) {
        results.push({
          name: passMatch[2],
          status: "pass",
          file: passMatch[1],
        })
        continue
      }

      // FAILED test_file.py::test_name - message
      const failMatch = trimmed.match(/^FAILED\s+(.+\.py)::(\S+)(?:\s+-\s+(.+))?/)
      if (failMatch) {
        // Check for existing entry (from compact format) and update it
        const existing = results.find((r) => r.name === failMatch[2] && r.file === failMatch[1])
        if (existing) {
          existing.status = "fail"
          if (failMatch[3]) existing.assertion = { message: failMatch[3] }
        } else {
          results.push({
            name: failMatch[2],
            status: "fail",
            file: failMatch[1],
            assertion: failMatch[3] ? { message: failMatch[3] } : undefined,
          })
        }
        continue
      }

      // ERROR test_file.py::test_name
      const errorMatch = trimmed.match(/^ERROR\s+(.+\.py)::(\S+)/)
      if (errorMatch) {
        results.push({
          name: errorMatch[2],
          status: "error",
          file: errorMatch[1],
        })
        continue
      }

      // Compact format: test_file.py::test_name PASSED/FAILED (but not lines starting with FAILED/ERROR/SKIPPED which are matched above)
      const compactMatch = trimmed.match(/^(.+\.py)::(\S+)\s+(PASSED|FAILED|ERROR|SKIPPED)/)
      if (compactMatch && !trimmed.startsWith("FAILED") && !trimmed.startsWith("ERROR") && !trimmed.startsWith("SKIPPED") && !results.some((r) => r.name === compactMatch[2] && r.file === compactMatch[1])) {
        results.push({
          name: compactMatch[2],
          status: compactMatch[3] === "PASSED" ? "pass" : compactMatch[3] === "FAILED" ? "fail" : compactMatch[3] === "ERROR" ? "error" : "skip",
          file: compactMatch[1],
        })
        continue
      }

      // Skipped: SKIPPED test_file.py::test_name
      const skipMatch = trimmed.match(/^SKIPPED\s+(.+\.py)::(\S+)/)
      if (skipMatch) {
        results.push({
          name: skipMatch[2],
          status: "skip",
          file: skipMatch[1],
        })
      }
    }

    // Summary line: X passed, Y failed, Z errors
    const summaryMatch = output.match(/(\d+)\s+passed/)
    const failSummaryMatch = output.match(/(\d+)\s+failed/)

    return {
      framework: "pytest",
      total: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    }
  }

  // ─── Go Test Parser ───────────────────────────────────────────

  function parseGo(output: string): TestSummary {
    const results: TestResult[] = []
    const lines = output.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()

      // --- PASS: TestName (0.00s)
      const passMatch = trimmed.match(/^---\s+PASS:\s+(\S+)\s+\(([\d.]+)s\)/)
      if (passMatch) {
        results.push({
          name: passMatch[1],
          status: "pass",
          duration: Math.round(parseFloat(passMatch[2]) * 1000),
        })
        continue
      }

      // --- FAIL: TestName (0.00s)
      const failMatch = trimmed.match(/^---\s+FAIL:\s+(\S+)\s+\(([\d.]+)s\)/)
      if (failMatch) {
        results.push({
          name: failMatch[1],
          status: "fail",
          duration: Math.round(parseFloat(failMatch[2]) * 1000),
        })
        continue
      }

      // --- SKIP: TestName (0.00s)
      const skipMatch = trimmed.match(/^---\s+SKIP:\s+(\S+)/)
      if (skipMatch) {
        results.push({
          name: skipMatch[1],
          status: "skip",
        })
        continue
      }
    }

    // Duration from ok/FAIL line: ok  package  0.123s
    const durMatch = output.match(/(?:ok|FAIL)\s+\S+\s+([\d.]+)s/)

    return {
      framework: "go",
      total: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      errors: results.filter((r) => r.status === "error").length,
      duration: durMatch ? Math.round(parseFloat(durMatch[1]) * 1000) : undefined,
      results,
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Extract line number from error context near a test failure. */
  function extractLineNumber(lines: string[], failIdx: number): number | undefined {
    for (let j = failIdx + 1; j < Math.min(failIdx + 10, lines.length); j++) {
      const lineMatch = lines[j].match(/at\s+.+?:(\d+):/)
      if (lineMatch) return parseInt(lineMatch[1], 10)

      const altMatch = lines[j].match(/:(\d+):(\d+)/)
      if (altMatch) return parseInt(altMatch[1], 10)
    }
    return undefined
  }

  /** Parse a duration string like "1.5" with unit "ms" or "s". */
  function parseDuration(value: string, unit: string): number {
    const num = parseFloat(value)
    return unit === "s" ? Math.round(num * 1000) : Math.round(num)
  }
}
