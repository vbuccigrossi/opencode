import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { tmpdir } from "os"
import { join } from "path"
import { randomUUID } from "crypto"
import { unlink, writeFile } from "fs/promises"

/**
 * Runtime sandbox — lightweight code evaluation engine.
 *
 * Allows the agent to evaluate expressions, run assertions, and call
 * module functions without writing permanent test files. All execution
 * happens via `bun run <tempfile>` with a hard timeout.
 *
 * Safety:
 * - 5-second hard timeout (kills process)
 * - Temp files always cleaned up
 * - Runs in project directory so imports resolve correctly
 */
export namespace Sandbox {
  const log = Log.create({ service: "sandbox" })

  /** Default timeout in milliseconds. */
  const DEFAULT_TIMEOUT = 5000

  /** Result of a sandbox evaluation. */
  export interface EvalResult {
    /** Whether the evaluation succeeded (exit code 0). */
    success: boolean
    /** Combined stdout output. */
    output: string
    /** stderr or exception message, if any. */
    error?: string
    /** Execution duration in milliseconds. */
    duration: number
  }

  /**
   * Evaluate a TypeScript/JavaScript expression or code block.
   *
   * Wraps the code in a temp file and runs it via `bun run`. Captures
   * stdout/stderr and returns structured results.
   *
   * @param code - Code to evaluate
   * @param options - Optional cwd and timeout overrides
   * @returns Evaluation result with output, error, and timing
   */
  export async function evaluate(
    code: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<EvalResult> {
    const cwd = options?.cwd ?? Instance.directory
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT
    return runCode(code, cwd, timeout)
  }

  /**
   * Run a boolean assertion. Returns pass/fail based on whether
   * the expression evaluates to a truthy value.
   *
   * @param expression - A boolean expression to assert
   * @param options - Optional cwd and timeout overrides
   * @returns Result where success=true means assertion passed
   */
  export async function assert(
    expression: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<EvalResult> {
    const cwd = options?.cwd ?? Instance.directory
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT

    const code = `
const __result = (${expression});
if (!__result) {
  console.error("Assertion failed: " + ${JSON.stringify(expression)} + " evaluated to " + JSON.stringify(__result));
  process.exit(1);
}
console.log("Assertion passed");
`
    return runCode(code, cwd, timeout)
  }

  /**
   * Import a module and call a specific function with arguments.
   *
   * Generates an import statement, calls the function, and prints
   * the JSON-stringified result.
   *
   * @param modulePath - Path to the module (relative or absolute)
   * @param functionName - Name of the exported function to call
   * @param args - Arguments to pass to the function
   * @param options - Optional cwd and timeout overrides
   * @returns Result with the function's return value as JSON in output
   */
  export async function call(
    modulePath: string,
    functionName: string,
    args: unknown[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<EvalResult> {
    const cwd = options?.cwd ?? Instance.directory
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT

    const argsStr = args.map((a) => JSON.stringify(a)).join(", ")
    const code = `
import { ${functionName} } from ${JSON.stringify(modulePath)};
const __result = await ${functionName}(${argsStr});
console.log(JSON.stringify(__result, null, 2));
`
    return runCode(code, cwd, timeout)
  }

  /**
   * Run a test snippet — evaluate an expression and compare to expected output.
   *
   * @param expression - Expression to evaluate
   * @param expected - Expected stringified result
   * @param options - Optional cwd and timeout overrides
   * @returns Result where success=true means the output matched
   */
  export async function testSnippet(
    expression: string,
    expected: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<EvalResult> {
    const cwd = options?.cwd ?? Instance.directory
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT

    const code = `
const __result = (${expression});
const __actual = typeof __result === "string" ? __result : JSON.stringify(__result);
const __expected = ${JSON.stringify(expected)};
if (__actual === __expected) {
  console.log("PASS: " + __actual);
} else {
  console.error("FAIL: expected " + __expected + " but got " + __actual);
  process.exit(1);
}
`
    return runCode(code, cwd, timeout)
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Core execution: writes code to a temp file, runs via bun, captures output.
   *
   * @param code - Code to execute
   * @param cwd - Working directory for execution
   * @param timeout - Max execution time in ms
   * @returns Structured result
   */
  async function runCode(
    code: string,
    cwd: string,
    timeout: number,
  ): Promise<EvalResult> {
    const tempFile = join(tmpdir(), `opencode-sandbox-${randomUUID().slice(0, 8)}.ts`)
    const startTime = Date.now()

    try {
      await writeFile(tempFile, code, "utf-8")

      const result = await runWithTimeout(tempFile, cwd, timeout)
      const duration = Date.now() - startTime

      log.info("sandbox eval", {
        success: result.success,
        duration,
        outputLen: result.stdout.length,
      })

      return {
        success: result.success,
        output: result.stdout.trim(),
        error: result.stderr.trim() || undefined,
        duration,
      }
    } catch (err: any) {
      const duration = Date.now() - startTime
      log.warn("sandbox error", { error: err.message, duration })

      return {
        success: false,
        output: "",
        error: err.message ?? String(err),
        duration,
      }
    } finally {
      // Always clean up temp file
      try {
        await unlink(tempFile)
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Runs a temp file via bun with a hard timeout.
   *
   * @param filePath - Path to the temp file to run
   * @param cwd - Working directory
   * @param timeout - Max time in ms
   * @returns stdout, stderr, and success flag
   */
  async function runWithTimeout(
    filePath: string,
    cwd: string,
    timeout: number,
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const { spawn } = await import("child_process")

    return new Promise((resolve, reject) => {
      const proc = spawn("bun", ["run", filePath], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "test" },
      })

      let stdout = ""
      let stderr = ""
      let killed = false

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
        // Cap output at 50KB to prevent memory issues
        if (stdout.length > 50_000) {
          stdout = stdout.slice(0, 50_000) + "\n[output truncated at 50KB]"
          proc.kill("SIGTERM")
          killed = true
        }
      })

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
        if (stderr.length > 50_000) {
          stderr = stderr.slice(0, 50_000) + "\n[stderr truncated at 50KB]"
        }
      })

      const timer = setTimeout(() => {
        killed = true
        proc.kill("SIGTERM")
        // Force kill after 1s grace period
        setTimeout(() => proc.kill("SIGKILL"), 1000)
      }, timeout)

      proc.on("close", (code) => {
        clearTimeout(timer)
        if (killed && code !== 0) {
          stderr = (stderr + "\n[killed: timeout exceeded]").trim()
        }
        resolve({
          success: code === 0,
          stdout,
          stderr,
        })
      })

      proc.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}
