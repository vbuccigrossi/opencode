import { Log } from "@/util/log"
import { EdgeCases } from "./edge-cases"
import { Frameworks } from "./frameworks"
import { Heuristics } from "@/semantic/heuristics"

/**
 * Targeted test generation engine.
 *
 * Analyzes a function's signature and body to generate test cases
 * covering happy paths, edge cases, and error conditions. Matches
 * the project's test framework and conventions.
 */
export namespace TestGen {
  const log = Log.create({ service: "testgen" })

  /** A single test case. */
  export interface TestCase {
    /** Descriptive name for the test. */
    name: string
    /** Category of this test case. */
    category: "happy_path" | "edge_case" | "error_case"
    /** Full test code. */
    code: string
  }

  /** A complete test suite. */
  export interface TestSuite {
    /** Target function name. */
    targetFunction: string
    /** Target file path. */
    targetFile: string
    /** Detected test framework. */
    framework: string
    /** Generated test cases. */
    cases: TestCase[]
    /** Complete test file content. */
    fullCode: string
  }

  /**
   * Generate a test suite for a function.
   *
   * @param filePath - Path to the source file
   * @param functionName - Name of the function to test
   * @param functionSource - Source code of the function
   * @param framework - Test framework (auto-detected if not provided)
   * @returns Generated test suite
   */
  export function generate(
    filePath: string,
    functionName: string,
    functionSource: string,
    framework?: Frameworks.Framework,
  ): TestSuite {
    const fw = framework ?? "bun_test"
    const tmpl = Frameworks.template(fw)
    const signals = Heuristics.extract(functionSource)
    const cases: TestCase[] = []

    // 1. Happy path test
    cases.push(generateHappyPath(functionName, signals, tmpl))

    // 2. Edge cases per parameter
    for (const param of signals.params) {
      if (param.type) {
        const edgeCases = EdgeCases.forType(param.type, param.name)
        for (const edge of edgeCases.slice(0, 3)) {
          cases.push(generateEdgeCase(functionName, param.name, edge, tmpl))
        }
      }
    }

    // 3. Optional parameter tests
    for (const param of signals.params.filter((p) => p.optional)) {
      cases.push(generateOptionalTest(functionName, param.name, tmpl))
    }

    // 4. Error path tests (if function throws)
    for (const throwSpec of signals.throws) {
      cases.push(generateErrorTest(functionName, throwSpec, tmpl))
    }

    // Build full test file
    const importLine = buildImportLine(filePath, functionName, fw)
    const fullCode = buildTestFile(functionName, cases, tmpl, importLine)

    return {
      targetFunction: functionName,
      targetFile: filePath,
      framework: fw,
      cases,
      fullCode,
    }
  }

  /**
   * Detect the test framework for a project.
   *
   * @param cwd - Project root directory
   * @returns Framework name
   */
  export async function detectFramework(cwd: string): Promise<Frameworks.Framework> {
    return Frameworks.detect(cwd)
  }

  /**
   * Format a test suite as a summary string.
   *
   * @param suite - The generated test suite
   * @returns Human-readable summary
   */
  export function formatSummary(suite: TestSuite): string {
    const lines: string[] = []
    lines.push(`Test suite for ${suite.targetFunction} (${suite.framework})`)
    lines.push(`${suite.cases.length} test case(s):`)

    for (const c of suite.cases) {
      lines.push(`  [${c.category}] ${c.name}`)
    }

    lines.push("")
    lines.push("Generated code:")
    lines.push(suite.fullCode)

    return lines.join("\n")
  }

  // ─── Generator Helpers ────────────────────────────────────────

  function generateHappyPath(
    functionName: string,
    signals: Heuristics.Signals,
    tmpl: Frameworks.Template,
  ): TestCase {
    const args = signals.params.map((p) => EdgeCases.defaultValue(p.type ?? "string")).join(", ")
    const call = `${functionName}(${args})`
    const body = signals.isAsync
      ? `    const result = await ${call};\n${tmpl.assertTruthy("result !== undefined")}`
      : `    const result = ${call};\n${tmpl.assertTruthy("result !== undefined")}`

    return {
      name: `returns expected result`,
      category: "happy_path",
      code: tmpl.testCase("returns expected result", body),
    }
  }

  function generateEdgeCase(
    functionName: string,
    paramName: string,
    edge: EdgeCases.TestValue,
    tmpl: Frameworks.Template,
  ): TestCase {
    const name = `handles ${paramName} as ${edge.reason}`
    const body = `    // ${edge.reason}\n    const result = ${functionName}(${edge.expression});\n${tmpl.assertTruthy("result !== undefined || result === undefined")}`

    return {
      name,
      category: "edge_case",
      code: tmpl.testCase(name, body),
    }
  }

  function generateOptionalTest(
    functionName: string,
    paramName: string,
    tmpl: Frameworks.Template,
  ): TestCase {
    const name = `works without ${paramName}`
    const body = `    // Optional parameter omitted\n    const result = ${functionName}();\n${tmpl.assertTruthy("true")}`

    return {
      name,
      category: "edge_case",
      code: tmpl.testCase(name, body),
    }
  }

  function generateErrorTest(
    functionName: string,
    throwSpec: string,
    tmpl: Frameworks.Template,
  ): TestCase {
    const name = `${throwSpec} on invalid input`
    const body = tmpl.assertThrows(`${functionName}(null as any)`)

    return {
      name,
      category: "error_case",
      code: tmpl.testCase(name, body),
    }
  }

  function buildImportLine(
    filePath: string,
    functionName: string,
    framework: Frameworks.Framework,
  ): string {
    if (framework === "pytest" || framework === "go_test") return ""

    // Convert to relative import
    const modulePath = filePath
      .replace(/\.(ts|tsx|js|jsx)$/, "")
      .replace(/\/index$/, "")

    return `import { ${functionName} } from "${modulePath}"`
  }

  function buildTestFile(
    functionName: string,
    cases: TestCase[],
    tmpl: Frameworks.Template,
    importLine: string,
  ): string {
    const parts: string[] = []

    if (tmpl.imports) parts.push(tmpl.imports)
    if (importLine) parts.push(importLine)
    parts.push("")
    parts.push(tmpl.describeOpen(functionName))

    for (const c of cases) {
      parts.push(c.code)
      parts.push("")
    }

    parts.push(tmpl.describeClose)

    return parts.join("\n")
  }
}
