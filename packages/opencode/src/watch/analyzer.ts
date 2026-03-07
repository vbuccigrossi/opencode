/**
 * Intelligent output analyzer for watched processes.
 *
 * Classifies output lines into errors, warnings, progress indicators,
 * and completion signals. Provides a structured summary of what happened.
 */
export namespace WatchAnalyzer {
  /** Analysis result for a batch of output lines. */
  export interface Result {
    /** Lines that match error patterns. */
    errors: ClassifiedLine[]
    /** Lines that match warning patterns. */
    warnings: ClassifiedLine[]
    /** Lines that match progress patterns. */
    progress: ClassifiedLine[]
    /** Whether the output suggests the process completed. */
    completion: boolean
    /** Suggested action based on analysis. */
    suggestedAction?: string
    /** Short summary of what happened. */
    summary: string
  }

  /** A classified output line. */
  export interface ClassifiedLine {
    /** The original line text. */
    text: string
    /** Line index in the batch. */
    index: number
    /** Classification source pattern. */
    source: string
  }

  // ---------------------------------------------------------------------------
  // Error patterns
  // ---------------------------------------------------------------------------

  const ERROR_PATTERNS: { pattern: RegExp; source: string }[] = [
    // TypeScript / JavaScript
    { pattern: /error TS\d+:/i, source: "typescript" },
    { pattern: /SyntaxError:/i, source: "syntax" },
    { pattern: /TypeError:/i, source: "type-error" },
    { pattern: /ReferenceError:/i, source: "reference-error" },
    { pattern: /RangeError:/i, source: "range-error" },
    // Generic error patterns
    { pattern: /\bERROR\b[:\s]/i, source: "generic-error" },
    { pattern: /\berror\[E\d+\]/i, source: "rust-error" },
    { pattern: /^error:/i, source: "error-prefix" },
    { pattern: /\bFAILED\b/i, source: "failed" },
    { pattern: /\bFAIL\b\s+\S+/, source: "test-fail" },
    { pattern: /\bpanic:/i, source: "panic" },
    { pattern: /\bsegmentation fault\b/i, source: "segfault" },
    // Python
    { pattern: /Traceback \(most recent call last\):/i, source: "python-traceback" },
    { pattern: /^(\w+Error):/m, source: "python-error" },
    // Go
    { pattern: /^# .+$/m, source: "go-build-error" },
    // Jest/Vitest
    { pattern: /\u25CF\s+.+/, source: "jest-failure" }, // ● test name
    { pattern: /Expected:?\s+.+\nReceived:?\s+.+/i, source: "jest-assertion" },
    // Exit codes
    { pattern: /exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]\d*/i, source: "non-zero-exit" },
    { pattern: /killed|terminated|aborted/i, source: "process-killed" },
  ]

  // ---------------------------------------------------------------------------
  // Warning patterns
  // ---------------------------------------------------------------------------

  const WARNING_PATTERNS: { pattern: RegExp; source: string }[] = [
    { pattern: /\bWARN(?:ING)?\b[:\s]/i, source: "warning" },
    { pattern: /\bDeprecated\b/i, source: "deprecated" },
    { pattern: /\bwarn\b[:\s]/i, source: "warn-prefix" },
    { pattern: /\bTODO\b/i, source: "todo" },
    { pattern: /\bFIXME\b/i, source: "fixme" },
    { pattern: /vulnerability|vulnerabilities/i, source: "vulnerability" },
  ]

  // ---------------------------------------------------------------------------
  // Progress patterns
  // ---------------------------------------------------------------------------

  const PROGRESS_PATTERNS: { pattern: RegExp; source: string }[] = [
    // Percentage
    { pattern: /\d+(\.\d+)?%/, source: "percentage" },
    // Step counts: 1/10, [3/5], (7 of 12)
    { pattern: /[\[(]?\d+\s*[/of]+\s*\d+[\])]?/, source: "step-count" },
    // Spinners / building indicators
    { pattern: /\b(building|compiling|bundling|installing|downloading|uploading)\b/i, source: "activity" },
    // Time elapsed
    { pattern: /\d+(\.\d+)?\s*(ms|s|sec|min|minutes|seconds)\b/i, source: "timing" },
    // Test counts
    { pattern: /\d+\s+(pass|passing|passed)\b/i, source: "tests-passing" },
  ]

  // ---------------------------------------------------------------------------
  // Completion patterns
  // ---------------------------------------------------------------------------

  const COMPLETION_PATTERNS: RegExp[] = [
    /\bdone\b[.!]?\s*$/i,
    /\bcomplete[d]?\b[.!]?\s*$/i,
    /\bfinished\b[.!]?\s*$/i,
    /\bsuccess(ful|fully)?\b[.!]?\s*$/i,
    /\bbuilt in\b/i,
    /\bready\b.*\b(in|at|on)\b/i,
    /\blistening\b.*\b(on|at)\b/i,
    /\bserver\b.*\bstarted\b/i,
    /\ball tests passed\b/i,
    /\b\d+\s+passed?,\s+\d+\s+total\b/i,
  ]

  /**
   * Analyze a batch of output lines.
   *
   * @param lines - New output lines to analyze
   * @returns Structured analysis result
   */
  export function analyze(lines: string[]): Result {
    const errors: ClassifiedLine[] = []
    const warnings: ClassifiedLine[] = []
    const progress: ClassifiedLine[] = []
    let completion = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue

      // Check errors
      for (const { pattern, source } of ERROR_PATTERNS) {
        if (pattern.test(line)) {
          errors.push({ text: line, index: i, source })
          break // One classification per line
        }
      }

      // Check warnings (only if not already an error)
      if (!errors.some((e) => e.index === i)) {
        for (const { pattern, source } of WARNING_PATTERNS) {
          if (pattern.test(line)) {
            warnings.push({ text: line, index: i, source })
            break
          }
        }
      }

      // Check progress (independently — a line can be both progress and warning)
      for (const { pattern, source } of PROGRESS_PATTERNS) {
        if (pattern.test(line)) {
          progress.push({ text: line, index: i, source })
          break
        }
      }

      // Check completion
      for (const pattern of COMPLETION_PATTERNS) {
        if (pattern.test(line)) {
          completion = true
          break
        }
      }
    }

    const summary = buildSummary(lines.length, errors, warnings, progress, completion)
    const suggestedAction = suggestAction(errors, warnings, completion)

    return { errors, warnings, progress, completion, suggestedAction, summary }
  }

  /** Build a short summary of the analysis. */
  function buildSummary(
    totalLines: number,
    errors: ClassifiedLine[],
    warnings: ClassifiedLine[],
    progress: ClassifiedLine[],
    completion: boolean,
  ): string {
    if (totalLines === 0) return "No new output."

    const parts: string[] = []
    parts.push(`${totalLines} new line(s)`)

    if (errors.length > 0) {
      parts.push(`${errors.length} error(s)`)
    }
    if (warnings.length > 0) {
      parts.push(`${warnings.length} warning(s)`)
    }
    if (progress.length > 0) {
      const lastProgress = progress[progress.length - 1]
      parts.push(`latest progress: "${lastProgress.text.trim().slice(0, 60)}"`)
    }
    if (completion) {
      parts.push("process appears complete")
    }

    return parts.join(". ") + "."
  }

  /** Suggest an action based on analysis. */
  function suggestAction(
    errors: ClassifiedLine[],
    warnings: ClassifiedLine[],
    completion: boolean,
  ): string | undefined {
    if (errors.length > 0) {
      const hasTestFail = errors.some((e) =>
        e.source === "test-fail" || e.source === "jest-failure",
      )
      if (hasTestFail) return "Tests failed. Run verify tool to parse errors."
      const hasBuildError = errors.some((e) =>
        e.source === "typescript" || e.source === "rust-error" || e.source === "go-build-error",
      )
      if (hasBuildError) return "Build errors detected. Run verify tool to get structured errors."
      return "Errors detected in output. Review and fix."
    }
    if (completion) {
      return "Process completed. Safe to proceed."
    }
    if (warnings.some((e) => e.source === "vulnerability")) {
      return "Vulnerabilities reported. Consider running security audit."
    }
    return undefined
  }
}
