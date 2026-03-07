import z from "zod"
import { Tool } from "./tool"
import { Verify } from "../verify"
import { Instance } from "../project/instance"

/**
 * Exposes project verification (typecheck, lint, test, build) to the agent.
 *
 * The agent can use this tool to check correctness after making edits,
 * run targeted tests, or verify the overall project state.
 */
export const VerifyTool = Tool.define("verify", async () => ({
  description: `Run project verification commands (typecheck, lint, test, build) and get structured error reports.

Use this tool AFTER making edits to verify correctness. It auto-detects project tooling (TypeScript, Python, Go, Rust, etc.) and runs the appropriate commands.

Operations:
- typecheck: Run the type checker (e.g., tsc, mypy, cargo check, go vet)
- test: Run the test suite (e.g., bun test, pytest, cargo test, go test)
- lint: Run the linter (e.g., eslint, ruff, clippy)
- build: Run the build command
- all: Run typecheck + test
- detect: Show which verification commands are available

Returns structured errors with file paths and line numbers for easy fixing.`,
  parameters: z.object({
    operation: z
      .enum(["typecheck", "test", "lint", "build", "all", "detect"])
      .describe("Which verification step(s) to run"),
    files: z
      .array(z.string())
      .optional()
      .describe("Specific test files to run (only for test operation)"),
  }),
  async execute(params): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    if (params.operation === "detect") {
      const cmds = Verify.commands()
      const entries = Object.entries(cmds).filter(([_, v]) => v)
      if (entries.length === 0) {
        return {
          title: "verify: detect",
          metadata: { count: 0 },
          output: "No verification commands detected for this project. Supported: Node/Bun (TypeScript), Python, Go, Rust.",
        }
      }
      const output = entries
        .map(([step, cmd]) => `${step}: ${cmd}`)
        .join("\n")
      return {
        title: "verify: detect",
        metadata: { count: entries.length, commands: cmds },
        output: `Detected verification commands:\n\n${output}`,
      }
    }

    const config = {
      typecheck: params.operation === "typecheck" || params.operation === "all",
      test: params.operation === "test" || params.operation === "all",
      lint: params.operation === "lint",
      build: params.operation === "build",
      files: params.files,
    }

    const result = await Verify.run(config)
    const output = Verify.format(result)

    return {
      title: `verify: ${params.operation}`,
      metadata: {
        count: result.totalErrors,
        success: result.success,
        totalErrors: result.totalErrors,
        totalWarnings: result.totalWarnings,
        durationMs: result.durationMs,
      },
      output,
    }
  },
}))
