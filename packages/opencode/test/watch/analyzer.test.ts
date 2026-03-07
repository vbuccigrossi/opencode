import { describe, expect, test } from "bun:test"
import { WatchAnalyzer } from "../../src/watch/analyzer"

describe("watch.analyzer", () => {
  test("detects TypeScript errors", () => {
    const result = WatchAnalyzer.analyze([
      "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable",
    ])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].source).toBe("typescript")
  })

  test("detects generic errors", () => {
    const result = WatchAnalyzer.analyze([
      "ERROR: Something went wrong",
      "error: compilation failed",
    ])
    expect(result.errors.length).toBe(2)
  })

  test("detects Rust errors", () => {
    const result = WatchAnalyzer.analyze([
      "error[E0308]: mismatched types",
    ])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].source).toBe("rust-error")
  })

  test("detects Python tracebacks", () => {
    const result = WatchAnalyzer.analyze([
      "Traceback (most recent call last):",
      '  File "main.py", line 10, in <module>',
      "ValueError: invalid literal",
    ])
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
  })

  test("detects test failures", () => {
    const result = WatchAnalyzer.analyze([
      "FAIL src/foo.test.ts",
    ])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].source).toBe("test-fail")
  })

  test("detects Jest-style failures", () => {
    const result = WatchAnalyzer.analyze([
      "\u25CF should return the correct value",
    ])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].source).toBe("jest-failure")
  })

  test("detects warnings", () => {
    const result = WatchAnalyzer.analyze([
      "WARNING: deprecated API usage",
      "warn: unused variable",
    ])
    expect(result.warnings.length).toBe(2)
  })

  test("detects vulnerability warnings", () => {
    const result = WatchAnalyzer.analyze([
      "found 3 vulnerabilities (1 moderate, 2 high)",
    ])
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0].source).toBe("vulnerability")
    expect(result.suggestedAction).toContain("security")
  })

  test("detects progress indicators", () => {
    const result = WatchAnalyzer.analyze([
      "Building... 45%",
      "[3/10] Compiling modules",
      "Installing dependencies...",
    ])
    expect(result.progress.length).toBe(3)
  })

  test("detects percentage progress", () => {
    const result = WatchAnalyzer.analyze(["Progress: 78.5%"])
    expect(result.progress.length).toBe(1)
    expect(result.progress[0].source).toBe("percentage")
  })

  test("detects step count progress", () => {
    const result = WatchAnalyzer.analyze(["[5/12] Processing files"])
    expect(result.progress.length).toBe(1)
    expect(result.progress[0].source).toBe("step-count")
  })

  test("detects completion", () => {
    const result = WatchAnalyzer.analyze([
      "Build done.",
    ])
    expect(result.completion).toBe(true)
  })

  test("detects server ready as completion", () => {
    const result = WatchAnalyzer.analyze([
      "Server listening on http://localhost:3000",
    ])
    expect(result.completion).toBe(true)
  })

  test("detects 'built in' as completion", () => {
    const result = WatchAnalyzer.analyze([
      "built in 1.23s",
    ])
    expect(result.completion).toBe(true)
  })

  test("does not classify empty lines", () => {
    const result = WatchAnalyzer.analyze(["", "  ", ""])
    expect(result.errors.length).toBe(0)
    expect(result.warnings.length).toBe(0)
    expect(result.progress.length).toBe(0)
  })

  test("no completion for normal output", () => {
    const result = WatchAnalyzer.analyze([
      "compiling src/main.rs",
      "processing file 3",
    ])
    expect(result.completion).toBe(false)
  })

  test("suggests action for build errors", () => {
    const result = WatchAnalyzer.analyze([
      "src/foo.ts(10,5): error TS2345: type mismatch",
    ])
    expect(result.suggestedAction).toContain("verify")
  })

  test("suggests action for test failures", () => {
    const result = WatchAnalyzer.analyze([
      "FAIL src/foo.test.ts",
    ])
    expect(result.suggestedAction).toContain("verify")
  })

  test("suggests safe to proceed on completion", () => {
    const result = WatchAnalyzer.analyze([
      "All tests passed!",
    ])
    expect(result.completion).toBe(true)
    expect(result.suggestedAction).toContain("proceed")
  })

  test("summary reports line count and errors", () => {
    const result = WatchAnalyzer.analyze([
      "compiling...",
      "error TS1234: something wrong",
      "done.",
    ])
    expect(result.summary).toContain("3 new line(s)")
    expect(result.summary).toContain("1 error(s)")
    expect(result.summary).toContain("complete")
  })

  test("summary for empty input", () => {
    const result = WatchAnalyzer.analyze([])
    expect(result.summary).toBe("No new output.")
  })

  test("error classification takes priority over warning", () => {
    // A line that matches both error and warning patterns
    const result = WatchAnalyzer.analyze([
      "ERROR: warning about something",
    ])
    expect(result.errors.length).toBe(1)
    // Should NOT also be classified as a warning
    expect(result.warnings.length).toBe(0)
  })

  test("handles non-zero exit code detection", () => {
    const result = WatchAnalyzer.analyze([
      "Process exited with code 1",
    ])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].source).toBe("non-zero-exit")
  })

  test("detects timing progress", () => {
    const result = WatchAnalyzer.analyze([
      "Completed in 2.5s",
    ])
    expect(result.progress.length).toBe(1)
    expect(result.progress[0].source).toBe("timing")
  })
})
