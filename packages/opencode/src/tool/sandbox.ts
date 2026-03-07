import z from "zod"
import { Tool } from "./tool"
import { Sandbox } from "../sandbox"

/**
 * Sandbox tool — allows the agent to evaluate code, run assertions,
 * and test function calls without writing permanent test files.
 *
 * Operations:
 * - eval: Evaluate a TypeScript/JavaScript expression and see the result
 * - assert: Test a boolean assertion (pass/fail)
 * - call: Import a module and call a specific exported function
 * - test_snippet: Evaluate an expression and compare to expected output
 */
export const SandboxTool = Tool.define("sandbox", {
  description: `Evaluate code, run assertions, and test function calls in a sandboxed environment.

Operations:
- eval: Execute TypeScript/JavaScript code and see stdout output
- assert: Test a boolean expression (returns pass/fail)
- call: Import a module and call an exported function with arguments
- test_snippet: Evaluate an expression and compare against expected output

Use this tool to:
- Quickly verify a function returns the right value before committing an edit
- Test a regex or string manipulation before using it in code
- Check that an import resolves and a function exists
- Run small experiments without creating test files

All code runs via bun with a 5-second timeout. Temp files are automatically cleaned up.`,
  parameters: z.object({
    operation: z
      .enum(["eval", "assert", "call", "test_snippet"])
      .describe("The sandbox operation to perform"),
    code: z
      .string()
      .optional()
      .describe("Code to evaluate (required for eval)"),
    expression: z
      .string()
      .optional()
      .describe("Boolean expression to assert (required for assert/test_snippet)"),
    module_path: z
      .string()
      .optional()
      .describe("Path to module to import (required for call)"),
    function_name: z
      .string()
      .optional()
      .describe("Exported function name (required for call)"),
    args: z
      .array(z.any())
      .optional()
      .describe("Arguments to pass to the function (for call)"),
    expected: z
      .string()
      .optional()
      .describe("Expected output string (required for test_snippet)"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 5000)"),
  }),
  async execute(params, ctx) {
    const opts = params.timeout ? { timeout: params.timeout } : undefined

    switch (params.operation) {
      case "eval":
        return sandboxEval(params.code, opts)
      case "assert":
        return sandboxAssert(params.expression, opts)
      case "call":
        return sandboxCall(params.module_path, params.function_name, params.args, opts)
      case "test_snippet":
        return sandboxTestSnippet(params.expression, params.expected, opts)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
})

/** Evaluate code and return output. */
async function sandboxEval(
  code?: string,
  opts?: { timeout?: number },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!code) throw new Error("code parameter is required for eval operation")

  const result = await Sandbox.evaluate(code, opts)
  return formatResult("eval", result)
}

/** Run a boolean assertion. */
async function sandboxAssert(
  expression?: string,
  opts?: { timeout?: number },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!expression) throw new Error("expression parameter is required for assert operation")

  const result = await Sandbox.assert(expression, opts)
  return formatResult("assert", result)
}

/** Import and call a function. */
async function sandboxCall(
  modulePath?: string,
  functionName?: string,
  args?: unknown[],
  opts?: { timeout?: number },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!modulePath) throw new Error("module_path parameter is required for call operation")
  if (!functionName) throw new Error("function_name parameter is required for call operation")

  const result = await Sandbox.call(modulePath, functionName, args ?? [], opts)
  return formatResult("call", result)
}

/** Evaluate and compare to expected. */
async function sandboxTestSnippet(
  expression?: string,
  expected?: string,
  opts?: { timeout?: number },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!expression) throw new Error("expression parameter is required for test_snippet operation")
  if (expected === undefined) throw new Error("expected parameter is required for test_snippet operation")

  const result = await Sandbox.testSnippet(expression, expected, opts)
  return formatResult("test_snippet", result)
}

/** Format a sandbox result into tool output. */
function formatResult(
  operation: string,
  result: Sandbox.EvalResult,
): { title: string; metadata: Record<string, any>; output: string } {
  const status = result.success ? "PASS" : "FAIL"
  const sections: string[] = []

  sections.push(`[${status}] (${result.duration}ms)`)

  if (result.output) {
    sections.push(`\nOutput:\n${result.output}`)
  }

  if (result.error) {
    sections.push(`\nError:\n${result.error}`)
  }

  return {
    title: `sandbox: ${operation} ${status.toLowerCase()}`,
    metadata: {
      truncated: false,
      operation,
      success: result.success,
      duration: result.duration,
    },
    output: sections.join("\n"),
  }
}
