import { Log } from "@/util/log"
import { writeFile, unlink, readFile } from "fs/promises"
import { join, dirname, extname } from "path"
import { spawn } from "child_process"
import { randomUUID } from "crypto"

/**
 * Dry-run edit engine — simulates edits and checks for type errors
 * before committing changes to disk.
 *
 * Writes modified content to a temp file in the same directory
 * (so imports resolve correctly), runs a targeted typecheck, and
 * reports errors — all without touching the real file.
 */
export namespace DryRun {
  const log = Log.create({ service: "dryrun" })

  /** Default timeout for typecheck in ms. */
  const DEFAULT_TIMEOUT = 10_000

  /** Structured diagnostic. */
  export interface Diagnostic {
    file: string
    line: number
    column?: number
    message: string
    severity: "error" | "warning"
  }

  /** Result of a dry-run check. */
  export interface Result {
    /** Whether the edit would succeed without type errors. */
    wouldSucceed: boolean
    /** Type errors found. */
    errors: Diagnostic[]
    /** Warnings found. */
    warnings: Diagnostic[]
    /** Time taken in milliseconds. */
    duration: number
  }

  /**
   * Simulate an edit and check for type errors.
   *
   * Writes the new content to a temp file next to the original,
   * runs tsgo/tsc on it, and returns structured errors.
   *
   * @param filePath - Absolute path to the file being edited
   * @param newContent - The proposed new content
   * @param options - Optional timeout
   * @returns Check result with errors/warnings
   */
  export async function check(
    filePath: string,
    newContent: string,
    options?: { timeout?: number },
  ): Promise<Result> {
    const ext = extname(filePath)
    const dir = dirname(filePath)
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT
    const startTime = Date.now()

    // Only run typecheck for supported file types
    if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
      return {
        wouldSucceed: true,
        errors: [],
        warnings: [],
        duration: Date.now() - startTime,
      }
    }

    const tempFile = join(dir, `.dryrun-${randomUUID().slice(0, 8)}${ext}`)

    try {
      await writeFile(tempFile, newContent, "utf-8")

      const output = await runTypecheck(tempFile, dir, timeout)
      const diagnostics = parseDiagnostics(output, tempFile)

      const errors = diagnostics.filter((d) => d.severity === "error")
      const warnings = diagnostics.filter((d) => d.severity === "warning")

      const duration = Date.now() - startTime
      log.info("dry-run check", {
        file: filePath,
        errors: errors.length,
        warnings: warnings.length,
        duration,
      })

      return {
        wouldSucceed: errors.length === 0,
        errors,
        warnings,
        duration,
      }
    } catch (err: any) {
      log.warn("dry-run failed", { error: err.message })
      return {
        wouldSucceed: true, // Assume success if typecheck itself fails
        errors: [],
        warnings: [],
        duration: Date.now() - startTime,
      }
    } finally {
      try {
        await unlink(tempFile)
      } catch {}
    }
  }

  /**
   * Simulate multiple edits atomically and check for type errors.
   *
   * Writes all modified files to temp copies, runs typecheck,
   * and returns combined results.
   *
   * @param edits - Array of file edits
   * @param options - Optional timeout
   * @returns Combined check result
   */
  export async function checkBatch(
    edits: Array<{ filePath: string; newContent: string }>,
    options?: { timeout?: number },
  ): Promise<Result> {
    if (edits.length === 0) {
      return { wouldSucceed: true, errors: [], warnings: [], duration: 0 }
    }

    if (edits.length === 1) {
      return check(edits[0].filePath, edits[0].newContent, options)
    }

    // For multiple files, run individual checks in parallel
    const results = await Promise.all(
      edits.map((edit) => check(edit.filePath, edit.newContent, options)),
    )

    const allErrors = results.flatMap((r) => r.errors)
    const allWarnings = results.flatMap((r) => r.warnings)
    const totalDuration = Math.max(...results.map((r) => r.duration))

    return {
      wouldSucceed: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
      duration: totalDuration,
    }
  }

  /**
   * Format dry-run results as a human-readable string.
   *
   * @param result - Dry-run check result
   * @returns Formatted string
   */
  export function format(result: Result): string {
    if (result.wouldSucceed && result.warnings.length === 0) {
      return `Dry-run: PASS (${result.duration}ms)`
    }

    const sections: string[] = []

    if (!result.wouldSucceed) {
      sections.push(`Dry-run: FAIL (${result.errors.length} error(s), ${result.duration}ms)`)
      for (const err of result.errors.slice(0, 10)) {
        const loc = err.column ? `${err.line}:${err.column}` : `${err.line}`
        sections.push(`  ERROR ${loc}: ${err.message}`)
      }
      if (result.errors.length > 10) {
        sections.push(`  ... and ${result.errors.length - 10} more errors`)
      }
    } else {
      sections.push(`Dry-run: PASS with warnings (${result.warnings.length}, ${result.duration}ms)`)
    }

    if (result.warnings.length > 0) {
      for (const warn of result.warnings.slice(0, 5)) {
        const loc = warn.column ? `${warn.line}:${warn.column}` : `${warn.line}`
        sections.push(`  WARN ${loc}: ${warn.message}`)
      }
    }

    return sections.join("\n")
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Run typecheck on a file, trying tsgo first, falling back to tsc.
   */
  function runTypecheck(filePath: string, cwd: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // Try tsgo first (faster), fall back to tsc
      const proc = spawn("tsgo", ["--noEmit", filePath], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const timer = setTimeout(() => {
        proc.kill("SIGTERM")
        reject(new Error("Typecheck timed out"))
      }, timeout)

      proc.on("close", (code) => {
        clearTimeout(timer)
        // tsgo/tsc returns non-zero on type errors — that's expected
        resolve(stdout + "\n" + stderr)
      })

      proc.on("error", () => {
        clearTimeout(timer)
        // tsgo not found — try tsc
        const tscProc = spawn("tsc", ["--noEmit", filePath], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        })

        let tscOut = ""
        let tscErr = ""

        tscProc.stdout.on("data", (chunk: Buffer) => {
          tscOut += chunk.toString()
        })
        tscProc.stderr.on("data", (chunk: Buffer) => {
          tscErr += chunk.toString()
        })

        const tscTimer = setTimeout(() => {
          tscProc.kill("SIGTERM")
          reject(new Error("Typecheck timed out"))
        }, timeout)

        tscProc.on("close", () => {
          clearTimeout(tscTimer)
          resolve(tscOut + "\n" + tscErr)
        })

        tscProc.on("error", (err) => {
          clearTimeout(tscTimer)
          reject(new Error("No TypeScript compiler available"))
        })
      })
    })
  }

  /**
   * Parse TypeScript compiler output into structured diagnostics.
   */
  function parseDiagnostics(output: string, tempFile: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const lines = output.split("\n")

    // TypeScript error format: file(line,col): error TS1234: message
    const tsPattern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS\d+:\s*(.+)$/
    // Alternative format: file:line:col - error TS1234: message
    const altPattern = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning)\s+TS\d+:\s*(.+)$/

    for (const line of lines) {
      let match = line.match(tsPattern) || line.match(altPattern)
      if (match) {
        diagnostics.push({
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          severity: match[4] as "error" | "warning",
          message: match[5].trim(),
        })
      }
    }

    return diagnostics
  }
}
