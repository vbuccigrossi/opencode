import z from "zod"
import { Tool } from "./tool"
import { TestGen } from "../testgen"
import { Instance } from "../project/instance"

/**
 * Test generation tool — analyzes functions and generates test suites.
 *
 * Operations:
 * - generate: Generate a test suite for a function
 * - detect_framework: Detect the project's test framework
 */
export const TestGenTool = Tool.define("testgen", {
  description: `Generate targeted test suites for functions.

Operations:
- generate: Analyze a function and generate test cases (happy path, edge cases, error cases)
- detect_framework: Detect the project's test framework (bun_test, vitest, jest, mocha, pytest, go_test)

Generates complete test files with proper imports and assertions, matching the project's test framework and conventions.`,
  parameters: z.object({
    operation: z
      .enum(["generate", "detect_framework"])
      .describe("The test generation operation to perform"),
    file_path: z
      .string()
      .optional()
      .describe("Path to the source file containing the function (required for generate)"),
    function_name: z
      .string()
      .optional()
      .describe("Name of the function to test (required for generate)"),
    function_source: z
      .string()
      .optional()
      .describe("Full source code of the function (required for generate)"),
    framework: z
      .enum(["bun_test", "vitest", "jest", "mocha", "pytest", "go_test"])
      .optional()
      .describe("Test framework override (auto-detected if not provided)"),
  }),
  async execute(params): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "generate":
        return testgenGenerate(params.file_path, params.function_name, params.function_source, params.framework)
      case "detect_framework":
        return await testgenDetect()
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
})

function testgenGenerate(filePath?: string, functionName?: string, functionSource?: string, framework?: any) {
  if (!filePath) throw new Error("file_path is required for generate")
  if (!functionName) throw new Error("function_name is required for generate")
  if (!functionSource) throw new Error("function_source is required for generate")

  const suite = TestGen.generate(filePath, functionName, functionSource, framework)
  return {
    title: `testgen: ${suite.cases.length} test(s) for ${functionName}`,
    metadata: {
      truncated: false,
      framework: suite.framework,
      caseCount: suite.cases.length,
      categories: {
        happy_path: suite.cases.filter((c) => c.category === "happy_path").length,
        edge_case: suite.cases.filter((c) => c.category === "edge_case").length,
        error_case: suite.cases.filter((c) => c.category === "error_case").length,
      },
    },
    output: TestGen.formatSummary(suite),
  }
}

async function testgenDetect() {
  const cwd = Instance.directory
  const framework = await TestGen.detectFramework(cwd)
  return {
    title: `testgen: detected ${framework}`,
    metadata: { truncated: false, framework },
    output: `Detected test framework: ${framework}`,
  }
}
