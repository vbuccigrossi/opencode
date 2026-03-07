import { describe, expect, test, beforeEach } from "bun:test"
import { Semantic } from "../../src/semantic"
import { Heuristics } from "../../src/semantic/heuristics"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"

describe("Heuristics", () => {
  describe("extract", () => {
    test("extracts params from function signature", () => {
      const source = `function greet(name: string, age: number): string {
  return "Hello " + name;
}`
      const signals = Heuristics.extract(source)
      expect(signals.params.length).toBe(2)
      expect(signals.params[0].name).toBe("name")
      expect(signals.params[0].type).toBe("string")
      expect(signals.params[1].name).toBe("age")
      expect(signals.params[1].type).toBe("number")
    })

    test("extracts return type", () => {
      const source = `function add(a: number, b: number): number {
  return a + b;
}`
      const signals = Heuristics.extract(source)
      expect(signals.returnType).toBe("number")
    })

    test("detects async functions", () => {
      const source = `async function fetchData(url: string): Promise<string> {
  return await fetch(url).then(r => r.text());
}`
      const signals = Heuristics.extract(source)
      expect(signals.isAsync).toBe(true)
    })

    test("detects side effects: file I/O", () => {
      const source = `function saveData(path: string, data: string) {
  writeFile(path, data);
}`
      const signals = Heuristics.extract(source)
      expect(signals.sideEffects).toContain("file I/O")
    })

    test("detects side effects: network", () => {
      const source = `async function getData() {
  const res = await fetch("https://api.example.com");
  return res.json();
}`
      const signals = Heuristics.extract(source)
      expect(signals.sideEffects).toContain("network request")
    })

    test("detects side effects: console", () => {
      const source = `function debug(msg: string) {
  console.log("Debug:", msg);
}`
      const signals = Heuristics.extract(source)
      expect(signals.sideEffects).toContain("console output")
    })

    test("detects throws", () => {
      const source = `function validate(x: number) {
  if (x < 0) throw new ValidationError("negative");
  if (x > 100) throw new Error("too large");
}`
      const signals = Heuristics.extract(source)
      expect(signals.throws.length).toBeGreaterThan(0)
      expect(signals.throws.some(t => t.includes("ValidationError"))).toBe(true)
    })

    test("measures complexity", () => {
      const source = `function complex(data: any[]) {
  for (const item of data) {
    if (item.type === "a") {
      for (const sub of item.children) {
        if (sub.valid) {
          try {
            process(sub);
          } catch (e) {
            handleError(e);
          }
        } else {
          skip(sub);
        }
      }
    } else if (item.type === "b") {
      transform(item);
    } else {
      ignore(item);
    }
  }
}`
      const signals = Heuristics.extract(source)
      expect(signals.complexity.branches).toBeGreaterThanOrEqual(2)
      expect(signals.complexity.loops).toBeGreaterThan(1)
      expect(signals.complexity.tryCatch).toBeGreaterThan(0)
    })

    test("extracts JSDoc docstring", () => {
      const comment = `/**
 * Calculates the sum of two numbers.
 * @param a First number
 * @param b Second number
 * @returns The sum
 */`
      const source = `function add(a: number, b: number): number {
  return a + b;
}`
      const signals = Heuristics.extract(source, comment)
      expect(signals.docstring).toContain("Calculates the sum")
    })

    test("handles optional params", () => {
      const source = `function search(query: string, limit?: number, offset = 0) {}`
      const signals = Heuristics.extract(source)
      expect(signals.params[0].optional).toBe(false)
      expect(signals.params[1].optional).toBe(true)
      expect(signals.params[2].optional).toBe(true)
    })

    test("handles arrow functions", () => {
      const source = `const multiply = (a: number, b: number) => a * b`
      const signals = Heuristics.extract(source)
      expect(signals.params.length).toBe(2)
    })
  })

  describe("summarize", () => {
    test("generates summary from docstring", () => {
      const signals = Heuristics.extract(
        "function add(a: number, b: number): number { return a + b; }",
        "/** Adds two numbers together. */",
      )
      const summary = Heuristics.summarize("add", "function", signals)
      expect(summary).toContain("Adds two numbers")
    })

    test("generates summary from signals when no docstring", () => {
      const signals = Heuristics.extract(
        "async function fetchUser(id: string): Promise<User> { return fetch(`/api/${id}`).then(r => r.json()); }",
      )
      const summary = Heuristics.summarize("fetchUser", "function", signals)
      expect(summary).toContain("Async")
      expect(summary).toContain("id")
      expect(summary).toContain("network request")
    })

    test("mentions side effects", () => {
      const signals = Heuristics.extract(
        "function save(data: string) { writeFile('/tmp/data', data); console.log('saved'); }",
      )
      const summary = Heuristics.summarize("save", "function", signals)
      expect(summary).toContain("file I/O")
    })
  })
})

describe("Semantic", () => {
  beforeEach(() => {
    Semantic.clearCache()
  })

  test("summarizes a function from source", () => {
    const summary = Semantic.summarize(
      "/tmp/math.ts",
      "add",
      "function add(a: number, b: number): number {\n  return a + b;\n}",
    )

    expect(summary.symbol).toBe("add")
    expect(summary.kind).toBe("function")
    expect(summary.inputs.length).toBe(2)
    expect(summary.outputs).toBe("number")
    expect(summary.complexity).toBe("simple")
  })

  test("caches summaries", () => {
    Semantic.summarize("/tmp/f.ts", "foo", "function foo() { return 1; }")
    const cached = Semantic.get("/tmp/f.ts", "foo")
    expect(cached).toBeDefined()
    expect(cached!.symbol).toBe("foo")
  })

  test("invalidates cache for file", () => {
    Semantic.summarize("/tmp/f.ts", "foo", "function foo() { return 1; }")
    Semantic.invalidate("/tmp/f.ts")
    expect(Semantic.get("/tmp/f.ts", "foo")).toBeUndefined()
  })

  test("summarizes a file with exports", async () => {
    const dir = join(tmpdir(), `semantic-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })

    writeFileSync(
      join(dir, "utils.ts"),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export const VERSION = "1.0.0"
`,
    )

    const summaries = await Semantic.summarizeFile(join(dir, "utils.ts"))
    expect(summaries.length).toBeGreaterThanOrEqual(2)
    expect(summaries.some((s) => s.symbol === "add")).toBe(true)
    expect(summaries.some((s) => s.symbol === "multiply")).toBe(true)

    rmSync(dir, { recursive: true })
  })

  test("formats summaries as semantic block", () => {
    const summaries = [
      Semantic.summarize("/tmp/a.ts", "foo", "function foo(): string { return 'bar'; }"),
      Semantic.summarize("/tmp/b.ts", "bar", "async function bar(x: number) { await fetch('/'); }"),
    ]

    const formatted = Semantic.format(summaries)
    expect(formatted).toContain("<semantic>")
    expect(formatted).toContain("</semantic>")
    expect(formatted).toContain("foo")
    expect(formatted).toContain("bar")
  })

  test("reports cache stats", () => {
    Semantic.summarize("/tmp/f.ts", "foo", "function foo() {}")
    expect(Semantic.cacheStats().size).toBe(1)
  })
})
