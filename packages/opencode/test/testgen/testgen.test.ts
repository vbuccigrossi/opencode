import { describe, expect, test, beforeEach } from "bun:test"
import { TestGen } from "../../src/testgen"
import { EdgeCases } from "../../src/testgen/edge-cases"
import { Frameworks } from "../../src/testgen/frameworks"
import { Heuristics } from "../../src/semantic/heuristics"

describe("TestGen", () => {
  describe("generate", () => {
    test("generates happy path test", () => {
      const source = `function add(a: number, b: number): number { return a + b }`
      const suite = TestGen.generate("src/math.ts", "add", source)

      expect(suite.targetFunction).toBe("add")
      expect(suite.targetFile).toBe("src/math.ts")
      expect(suite.framework).toBe("bun_test")
      expect(suite.cases.length).toBeGreaterThan(0)

      const happyPath = suite.cases.find((c) => c.category === "happy_path")
      expect(happyPath).toBeDefined()
      expect(happyPath!.name).toContain("returns expected result")
    })

    test("generates edge cases for parameters", () => {
      const source = `function greet(name: string): string { return "Hello " + name }`
      const suite = TestGen.generate("src/greet.ts", "greet", source)

      const edgeCases = suite.cases.filter((c) => c.category === "edge_case")
      expect(edgeCases.length).toBeGreaterThan(0)
    })

    test("generates error tests for throwing functions", () => {
      const source = `function validate(input: string): void {
        if (!input) throw new Error("input required")
      }`
      const suite = TestGen.generate("src/validate.ts", "validate", source)

      const errorCases = suite.cases.filter((c) => c.category === "error_case")
      expect(errorCases.length).toBeGreaterThan(0)
    })

    test("generates optional parameter tests", () => {
      const source = `function fetch(url: string, timeout?: number): string { return "" }`
      const suite = TestGen.generate("src/fetch.ts", "fetch", source)

      const optTests = suite.cases.filter((c) => c.name.includes("without"))
      expect(optTests.length).toBeGreaterThan(0)
    })

    test("generates complete test file code", () => {
      const source = `function add(a: number, b: number): number { return a + b }`
      const suite = TestGen.generate("src/math.ts", "add", source)

      expect(suite.fullCode).toContain("describe")
      expect(suite.fullCode).toContain("add")
      expect(suite.fullCode).toContain("import")
    })

    test("respects framework parameter", () => {
      const source = `function add(a: number, b: number): number { return a + b }`
      const suite = TestGen.generate("src/math.ts", "add", source, "vitest")

      expect(suite.framework).toBe("vitest")
      expect(suite.fullCode).toContain("vitest")
    })

    test("formatSummary produces readable output", () => {
      const source = `function add(a: number, b: number): number { return a + b }`
      const suite = TestGen.generate("src/math.ts", "add", source)
      const summary = TestGen.formatSummary(suite)

      expect(summary).toContain("Test suite for add")
      expect(summary).toContain("test case(s)")
    })
  })
})

describe("EdgeCases", () => {
  test("generates string edge cases", () => {
    const cases = EdgeCases.forType("string")
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.some((c) => c.reason === "empty string")).toBe(true)
  })

  test("generates context-aware string cases for path params", () => {
    const cases = EdgeCases.forType("string", "filePath")
    expect(cases.some((c) => c.reason.includes("path"))).toBe(true)
  })

  test("generates number edge cases", () => {
    const cases = EdgeCases.forType("number")
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.some((c) => c.reason === "zero")).toBe(true)
    expect(cases.some((c) => c.reason === "negative")).toBe(true)
  })

  test("generates boolean edge cases", () => {
    const cases = EdgeCases.forType("boolean")
    expect(cases.length).toBe(2)
  })

  test("generates array edge cases", () => {
    const cases = EdgeCases.forType("string[]")
    expect(cases.some((c) => c.reason === "empty array")).toBe(true)
  })

  test("generates optional edge cases", () => {
    const cases = EdgeCases.forType("string | undefined")
    expect(cases.some((c) => c.reason === "not provided")).toBe(true)
  })

  test("defaultValue returns reasonable defaults", () => {
    expect(EdgeCases.defaultValue("string")).toBe('"test"')
    expect(EdgeCases.defaultValue("number")).toBe("42")
    expect(EdgeCases.defaultValue("boolean")).toBe("true")
    expect(EdgeCases.defaultValue("string[]")).toBe("[1, 2, 3]")
  })
})

describe("Frameworks", () => {
  test("template returns bun_test by default", () => {
    const tmpl = Frameworks.template("bun_test")
    expect(tmpl.imports).toContain("bun:test")
    expect(tmpl.extension).toBe(".test.ts")
  })

  test("template returns vitest template", () => {
    const tmpl = Frameworks.template("vitest")
    expect(tmpl.imports).toContain("vitest")
  })

  test("template returns jest template", () => {
    const tmpl = Frameworks.template("jest")
    expect(tmpl.describeOpen("Foo")).toContain("describe")
  })

  test("template returns pytest template", () => {
    const tmpl = Frameworks.template("pytest")
    expect(tmpl.imports).toContain("pytest")
    expect(tmpl.describeOpen("Foo")).toContain("class")
  })

  test("template returns go_test template", () => {
    const tmpl = Frameworks.template("go_test")
    expect(tmpl.imports).toContain("testing")
    expect(tmpl.describeOpen("Foo")).toContain("func Test")
  })

  test("testCase generates proper test structure", () => {
    const tmpl = Frameworks.template("bun_test")
    const code = tmpl.testCase("should work", "    const x = 1")
    expect(code).toContain("test(")
    expect(code).toContain("should work")
  })

  test("assertThrows generates proper assertion", () => {
    const tmpl = Frameworks.template("bun_test")
    const code = tmpl.assertThrows("foo()")
    expect(code).toContain("toThrow")
  })
})
