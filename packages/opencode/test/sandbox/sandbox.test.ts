import { describe, expect, test } from "bun:test"
import { Sandbox } from "../../src/sandbox"

/** All tests pass cwd explicitly to avoid Instance context requirement. */
const cwd = "/tmp"

describe("Sandbox", () => {
  describe("evaluate", () => {
    test("evaluates simple expression", async () => {
      const result = await Sandbox.evaluate("console.log(2 + 2)", { cwd })
      expect(result.success).toBe(true)
      expect(result.output).toBe("4")
      expect(result.error).toBeUndefined()
      expect(result.duration).toBeGreaterThan(0)
    })

    test("evaluates multi-line code", async () => {
      const code = `
const arr = [1, 2, 3, 4, 5]
const sum = arr.reduce((a, b) => a + b, 0)
console.log(sum)
`
      const result = await Sandbox.evaluate(code, { cwd })
      expect(result.success).toBe(true)
      expect(result.output).toBe("15")
    })

    test("captures stderr on error", async () => {
      const result = await Sandbox.evaluate("throw new Error('boom')", { cwd })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!).toContain("boom")
    })

    test("returns failure for syntax errors", async () => {
      const result = await Sandbox.evaluate("const x = {{{", { cwd })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    test("respects timeout", async () => {
      const result = await Sandbox.evaluate(
        "while(true) {}",
        { cwd, timeout: 1000 },
      )
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.duration).toBeLessThan(5000)
    })

    test("uses custom cwd", async () => {
      const result = await Sandbox.evaluate(
        "console.log(process.cwd())",
        { cwd: "/tmp" },
      )
      expect(result.success).toBe(true)
      expect(result.output).toBe("/tmp")
    })

    test("cleans up temp files", async () => {
      const { tmpdir } = await import("os")
      const { readdirSync } = await import("fs")
      const before = readdirSync(tmpdir()).filter(f => f.startsWith("opencode-sandbox-"))
      await Sandbox.evaluate("console.log('test')", { cwd })
      const after = readdirSync(tmpdir()).filter(f => f.startsWith("opencode-sandbox-"))
      expect(after.length).toBeLessThanOrEqual(before.length)
    })

    test("handles empty output", async () => {
      const result = await Sandbox.evaluate("// no output", { cwd })
      expect(result.success).toBe(true)
      expect(result.output).toBe("")
    })

    test("handles multiple console.log calls", async () => {
      const code = `
console.log("line1")
console.log("line2")
console.log("line3")
`
      const result = await Sandbox.evaluate(code, { cwd })
      expect(result.success).toBe(true)
      expect(result.output).toContain("line1")
      expect(result.output).toContain("line2")
      expect(result.output).toContain("line3")
    })

    test("handles process.exit(0) as success", async () => {
      const result = await Sandbox.evaluate("process.exit(0)", { cwd })
      expect(result.success).toBe(true)
    })

    test("handles process.exit(1) as failure", async () => {
      const result = await Sandbox.evaluate("process.exit(1)", { cwd })
      expect(result.success).toBe(false)
    })
  })

  describe("assert", () => {
    test("passes for truthy expression", async () => {
      const result = await Sandbox.assert("2 + 2 === 4", { cwd })
      expect(result.success).toBe(true)
      expect(result.output).toContain("passed")
    })

    test("fails for falsy expression", async () => {
      const result = await Sandbox.assert("2 + 2 === 5", { cwd })
      expect(result.success).toBe(false)
      expect(result.error).toContain("Assertion failed")
    })

    test("passes for truthy non-boolean", async () => {
      const result = await Sandbox.assert('"hello"', { cwd })
      expect(result.success).toBe(true)
    })

    test("fails for null", async () => {
      const result = await Sandbox.assert("null", { cwd })
      expect(result.success).toBe(false)
    })

    test("handles complex expressions", async () => {
      const result = await Sandbox.assert('[1,2,3].includes(2) && "hello".length === 5', { cwd })
      expect(result.success).toBe(true)
    })

    test("handles expression errors", async () => {
      const result = await Sandbox.assert("undefined.foo", { cwd })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe("call", () => {
    test("calls a module function", async () => {
      const result = await Sandbox.call("path", "join", ["/tmp", "test.txt"], { cwd })
      expect(result.success).toBe(true)
      expect(result.output).toContain("/tmp/test.txt")
    })

    test("calls with no arguments", async () => {
      const result = await Sandbox.call("os", "tmpdir", [], { cwd })
      expect(result.success).toBe(true)
      expect(result.output.length).toBeGreaterThan(0)
    })

    test("fails for non-existent module", async () => {
      const result = await Sandbox.call("nonexistent-module-xyz", "foo", [], { cwd })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    test("fails for non-existent function", async () => {
      const result = await Sandbox.call("path", "nonExistentFn", [], { cwd })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe("testSnippet", () => {
    test("passes when output matches expected", async () => {
      const result = await Sandbox.testSnippet("2 + 2", "4", { cwd })
      expect(result.success).toBe(true)
      expect(result.output).toContain("PASS")
    })

    test("fails when output doesn't match", async () => {
      const result = await Sandbox.testSnippet("2 + 2", "5", { cwd })
      expect(result.success).toBe(false)
      expect(result.error).toContain("FAIL")
      expect(result.error).toContain("expected 5")
      expect(result.error).toContain("got 4")
    })

    test("handles string results", async () => {
      const result = await Sandbox.testSnippet('"hello" + " world"', "hello world", { cwd })
      expect(result.success).toBe(true)
    })

    test("handles JSON results", async () => {
      const result = await Sandbox.testSnippet("[1,2,3]", "[1,2,3]", { cwd })
      expect(result.success).toBe(true)
    })

    test("handles object results", async () => {
      const result = await Sandbox.testSnippet('({a: 1})', '{"a":1}', { cwd })
      expect(result.success).toBe(true)
    })
  })

  describe("performance", () => {
    test("simple eval completes in under 500ms", async () => {
      const result = await Sandbox.evaluate("console.log('fast')", { cwd })
      expect(result.success).toBe(true)
      expect(result.duration).toBeLessThan(500)
    })
  })
})
