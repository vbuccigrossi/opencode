import { $ } from "bun"
import { VerifyDetect } from "./detect"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

/**
 * Verification engine — runs typecheck, lint, test, and build commands
 * and parses their output into structured error reports.
 *
 * Used after edits to validate correctness and feed structured errors
 * back to the agent for self-repair.
 */
export namespace VerifyEngine {
  const log = Log.create({ service: "verify.engine" })

  /** A single structured error from verification output. */
  export interface VerifyError {
    file?: string
    line?: number
    column?: number
    message: string
    severity: "error" | "warning"
    code?: string
  }

  /** Result of a single verification step. */
  export interface StepResult {
    step: "typecheck" | "lint" | "test" | "build"
    success: boolean
    errors: VerifyError[]
    output: string
    durationMs: number
  }

  /** Result of the full verification pipeline. */
  export interface VerifyResult {
    steps: StepResult[]
    success: boolean
    totalErrors: number
    totalWarnings: number
    durationMs: number
  }

  /** Per-step timeout configuration. */
  export interface StepTimeouts {
    typecheck?: number
    test?: number
    lint?: number
    build?: number
  }

  /** Configuration for which steps to run. */
  export interface VerifyConfig {
    /** Run type checker (default: true if detected) */
    typecheck?: boolean
    /** Run linter (default: false — can be noisy) */
    lint?: boolean
    /** Run tests (default: false — can be slow) */
    test?: boolean
    /** Run build (default: false) */
    build?: boolean
    /** Custom commands override auto-detection */
    commands?: VerifyDetect.Commands
    /** Maximum output length per step in characters (default: 5000) */
    maxOutput?: number
    /** Timeout per step in ms (default: 30000) */
    timeout?: number
    /** Per-step timeouts override the global timeout */
    stepTimeouts?: StepTimeouts
    /** Only check specific files (for targeted verification) */
    files?: string[]
    /** Enable targeted (per-file) verification when supported */
    targeted?: boolean
  }

  const DEFAULT_CONFIG: Required<Pick<VerifyConfig, "maxOutput" | "timeout">> = {
    maxOutput: 5000,
    timeout: 30_000,
  }

  /** Default per-step timeouts. */
  const DEFAULT_STEP_TIMEOUTS: Required<StepTimeouts> = {
    typecheck: 30_000,
    test: 60_000,
    lint: 15_000,
    build: 60_000,
  }

  /**
   * Runs verification steps on the project.
   *
   * Auto-detects commands if not provided. Runs requested steps
   * sequentially and collects structured error output.
   *
   * @param directory - Project root directory
   * @param config - Which steps to run and how
   * @returns Structured verification result
   */
  export async function run(
    directory: string,
    config: VerifyConfig = {},
  ): Promise<VerifyResult> {
    const start = Date.now()
    const commands = config.commands ?? VerifyDetect.detect(directory)
    const maxOutput = config.maxOutput ?? DEFAULT_CONFIG.maxOutput
    const globalTimeout = config.timeout ?? DEFAULT_CONFIG.timeout
    const stepTimeouts = config.stepTimeouts ?? {}
    const files = config.files ?? []
    const targeted = config.targeted ?? false
    const steps: StepResult[] = []

    /** Resolves the timeout for a given step. */
    const timeoutFor = (step: StepResult["step"]): number =>
      stepTimeouts[step] ?? globalTimeout ?? DEFAULT_STEP_TIMEOUTS[step]

    /** Builds the command, applying file targeting if supported. */
    const buildCmd = (step: StepResult["step"], baseCmd: string): string => {
      if (!targeted || files.length === 0) return baseCmd
      return VerifyDetect.buildTargetedCommand(baseCmd, step, files, directory)
    }

    // Typecheck
    if (config.typecheck !== false && commands.typecheck) {
      const cmd = buildCmd("typecheck", commands.typecheck)
      steps.push(await runStep("typecheck", cmd, directory, maxOutput, timeoutFor("typecheck")))
    }

    // Lint
    if (config.lint === true && commands.lint) {
      const cmd = buildCmd("lint", commands.lint)
      steps.push(await runStep("lint", cmd, directory, maxOutput, timeoutFor("lint")))
    }

    // Test
    if (config.test === true && commands.test) {
      const testCmd = files.length > 0
        ? VerifyDetect.buildTargetedCommand(commands.test, "test", files, directory)
        : commands.test
      steps.push(await runStep("test", testCmd, directory, maxOutput, timeoutFor("test")))
    }

    // Build
    if (config.build === true && commands.build) {
      const cmd = buildCmd("build", commands.build)
      steps.push(await runStep("build", cmd, directory, maxOutput, timeoutFor("build")))
    }

    const success = steps.every((s) => s.success)
    const totalErrors = steps.reduce((sum, s) => sum + s.errors.filter((e) => e.severity === "error").length, 0)
    const totalWarnings = steps.reduce((sum, s) => sum + s.errors.filter((e) => e.severity === "warning").length, 0)

    log.info("verification complete", {
      success,
      totalErrors,
      totalWarnings,
      steps: steps.map((s) => ({ step: s.step, success: s.success, errors: s.errors.length })),
      durationMs: Date.now() - start,
    })

    return {
      steps,
      success,
      totalErrors,
      totalWarnings,
      durationMs: Date.now() - start,
    }
  }

  /**
   * Runs a single verification step.
   */
  async function runStep(
    step: StepResult["step"],
    command: string,
    directory: string,
    maxOutput: number,
    timeout: number,
  ): Promise<StepResult> {
    const start = Date.now()

    try {
      const proc = $`sh -c ${command}`
        .cwd(directory)
        .quiet()
        .nothrow()

      // Apply timeout via AbortSignal
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      let rawOutput: string
      try {
        rawOutput = await proc.text()
      } finally {
        clearTimeout(timer)
      }

      const output = rawOutput.length > maxOutput
        ? rawOutput.slice(0, maxOutput) + "\n... (output truncated)"
        : rawOutput

      // Parse errors from output
      const errors = parseErrors(output, step)
      const success = errors.filter((e) => e.severity === "error").length === 0

      return {
        step,
        success,
        errors,
        output,
        durationMs: Date.now() - start,
      }
    } catch (err: any) {
      // Command failed (non-zero exit or timeout)
      const rawOutput = err?.stdout ?? err?.stderr ?? err?.message ?? String(err)
      const output = typeof rawOutput === "string"
        ? rawOutput.length > maxOutput
          ? rawOutput.slice(0, maxOutput) + "\n... (output truncated)"
          : rawOutput
        : String(rawOutput)

      const errors = parseErrors(output, step)
      // If no specific errors parsed, create a generic one
      if (errors.length === 0) {
        errors.push({
          message: `${step} failed: ${output.slice(0, 200)}`,
          severity: "error",
        })
      }

      return {
        step,
        success: false,
        errors,
        output,
        durationMs: Date.now() - start,
      }
    }
  }

  /**
   * Parses structured errors from command output.
   *
   * Supports common error formats:
   * - TypeScript: `file.ts(line,col): error TS1234: message`
   * - tsgo/tsc: `file.ts:line:col - error TS1234: message`
   * - ESLint/generic: `file.ts:line:col: error message`
   * - Rust: `error[E0123]: message` + `--> file.rs:line:col`
   * - Python: `file.py:line: error: message`
   * - Go: `file.go:line:col: message`
   * - Jest/Vitest: `FAIL src/foo.test.ts` + assertion errors
   * - pytest: `FAILED tests/test_foo.py::test_name - message`
   * - Bun test: `error: expect(received)...` format
   */
  function parseErrors(output: string, step: StepResult["step"]): VerifyError[] {
    const errors: VerifyError[] = []
    const lines = output.split("\n")
    const seen = new Set<string>()

    // Track the last Rust error for location line attachment
    let lastRustError: VerifyError | undefined

    for (let i = 0; i < lines.length; i++) {
      const error = parseLine(lines[i], step, lastRustError)
      if (error) {
        // Check if this was a Rust location line that enriched the last error
        if (error === lastRustError) continue

        const key = `${error.file}:${error.line}:${error.message}`
        if (!seen.has(key)) {
          seen.add(key)
          errors.push(error)
        }

        // Track Rust errors for location attachment
        if (error.code && /^[A-Z]\d+$/.test(error.code)) {
          lastRustError = error
        } else {
          lastRustError = undefined
        }
      }
    }

    return errors
  }

  /**
   * Attempts to parse a single line of output into a structured error.
   *
   * @param line - Raw output line
   * @param step - Current verification step
   * @param lastRustError - Previous Rust error for location attachment
   */
  function parseLine(
    line: string,
    step: StepResult["step"],
    lastRustError?: VerifyError,
  ): VerifyError | undefined {
    const trimmed = line.trim()
    if (!trimmed) return undefined

    // TypeScript: src/file.ts(10,5): error TS2345: Argument of type...
    const tsMatch = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/.exec(trimmed)
    if (tsMatch) {
      return {
        file: tsMatch[1],
        line: parseInt(tsMatch[2], 10),
        column: parseInt(tsMatch[3], 10),
        severity: tsMatch[4] as "error" | "warning",
        code: tsMatch[5],
        message: tsMatch[6],
      }
    }

    // tsgo/tsc alternative format: src/file.ts:10:5 - error TS2345: ...
    const tsAltMatch = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):\s*(.+)$/.exec(trimmed)
    if (tsAltMatch) {
      return {
        file: tsAltMatch[1],
        line: parseInt(tsAltMatch[2], 10),
        column: parseInt(tsAltMatch[3], 10),
        severity: tsAltMatch[4] as "error" | "warning",
        code: tsAltMatch[5],
        message: tsAltMatch[6],
      }
    }

    // Generic: file.ts:10:5: error: message  OR  file.ts:10: error: message
    const genericMatch = /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|Error|Warning)(?:\[.*?\])?:\s*(.+)$/.exec(trimmed)
    if (genericMatch) {
      return {
        file: genericMatch[1],
        line: parseInt(genericMatch[2], 10),
        column: genericMatch[3] ? parseInt(genericMatch[3], 10) : undefined,
        severity: genericMatch[4].toLowerCase().startsWith("e") ? "error" : "warning",
        message: genericMatch[5],
      }
    }

    // Rust: error[E0382]: borrow of moved value
    const rustMatch = /^(error|warning)\[([A-Z]\d+)\]:\s*(.+)$/.exec(trimmed)
    if (rustMatch) {
      return {
        severity: rustMatch[1] as "error" | "warning",
        code: rustMatch[2],
        message: rustMatch[3],
      }
    }

    // Rust location line: --> src/main.rs:10:5
    // Attach file/line to the previous Rust error
    if (lastRustError && !lastRustError.file) {
      const rustLocMatch = /^\s*-->\s*(.+?):(\d+):(\d+)/.exec(trimmed)
      if (rustLocMatch) {
        lastRustError.file = rustLocMatch[1]
        lastRustError.line = parseInt(rustLocMatch[2], 10)
        lastRustError.column = parseInt(rustLocMatch[3], 10)
        return lastRustError // Signal: enriched existing error, don't add new
      }
    }

    // Jest/Vitest: FAIL src/foo.test.ts
    const jestFailMatch = /^\s*FAIL\s+(.+?\.(test|spec)\.\w+)/.exec(trimmed)
    if (jestFailMatch && step === "test") {
      return {
        file: jestFailMatch[1],
        severity: "error",
        message: `Test file failed: ${jestFailMatch[1]}`,
      }
    }

    // pytest: FAILED tests/test_foo.py::test_name - AssertionError: message
    const pytestMatch = /^FAILED\s+(.+?\.py)::(\S+)\s*-\s*(.+)$/.exec(trimmed)
    if (pytestMatch) {
      return {
        file: pytestMatch[1],
        severity: "error",
        message: `${pytestMatch[2]}: ${pytestMatch[3]}`,
      }
    }

    // Bun test: error: expect(received).toBe(expected) at file.test.ts:line:col
    const bunTestMatch = /^error:.*at\s+(.+?):(\d+):(\d+)/.exec(trimmed)
    if (bunTestMatch && step === "test") {
      return {
        file: bunTestMatch[1],
        line: parseInt(bunTestMatch[2], 10),
        column: parseInt(bunTestMatch[3], 10),
        severity: "error",
        message: trimmed.replace(/^error:\s*/, ""),
      }
    }

    return undefined
  }

  /**
   * Formats a verification result into a human-readable string
   * suitable for injection into the agent prompt.
   *
   * @param result - Verification result
   * @returns Formatted string
   */
  export function format(result: VerifyResult): string {
    if (result.success) {
      const steps = result.steps.map((s) => s.step).join(", ")
      return `Verification passed (${steps}). No errors detected.`
    }

    const sections: string[] = []

    for (const step of result.steps) {
      if (step.success) continue

      const errorLines = step.errors
        .filter((e) => e.severity === "error")
        .slice(0, 20)
        .map((e) => {
          const loc = e.file
            ? `${e.file}${e.line ? `:${e.line}` : ""}${e.column ? `:${e.column}` : ""}`
            : "(unknown)"
          return `  ${loc}: ${e.code ? `[${e.code}] ` : ""}${e.message}`
        })

      sections.push(
        `${step.step} FAILED (${step.errors.filter((e) => e.severity === "error").length} errors):\n${errorLines.join("\n")}`,
      )
    }

    return `Verification failed:\n\n${sections.join("\n\n")}`
  }
}
