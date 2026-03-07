import { describe, expect, test, beforeEach } from "bun:test"
import { CascadeTransforms } from "../../src/cascade/transforms"
import { Cascade } from "../../src/cascade"
import { writeFile, mkdtemp, rm, readFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

describe("CascadeTransforms", () => {
  describe("splitArgs", () => {
    test("splits simple arguments", () => {
      expect(CascadeTransforms.splitArgs("a, b, c")).toEqual(["a", "b", "c"])
    })

    test("handles empty string", () => {
      expect(CascadeTransforms.splitArgs("")).toEqual([])
    })

    test("respects nested parens", () => {
      expect(CascadeTransforms.splitArgs("foo(1, 2), bar")).toEqual(["foo(1, 2)", "bar"])
    })

    test("respects string literals", () => {
      expect(CascadeTransforms.splitArgs('"hello, world", 42')).toEqual(['"hello, world"', "42"])
    })

    test("respects nested objects", () => {
      expect(CascadeTransforms.splitArgs("{ a: 1, b: 2 }, c")).toEqual(["{ a: 1, b: 2 }", "c"])
    })

    test("respects template literals", () => {
      expect(CascadeTransforms.splitArgs('`a, b`, c')).toEqual(["`a, b`", "c"])
    })
  })

  describe("findMatchingParen", () => {
    test("finds matching paren", () => {
      expect(CascadeTransforms.findMatchingParen("foo(a, b)", 3)).toBe(8)
    })

    test("handles nested parens", () => {
      expect(CascadeTransforms.findMatchingParen("foo(bar(1), 2)", 3)).toBe(13)
    })

    test("returns -1 for unmatched", () => {
      expect(CascadeTransforms.findMatchingParen("foo(a", 3)).toBe(-1)
    })

    test("handles strings with parens", () => {
      // foo("(", b) — opening at 3, closing at 10
      expect(CascadeTransforms.findMatchingParen('foo("(", b)', 3)).toBe(10)
    })
  })

  describe("applyTransform", () => {
    test("add_param appends at end", () => {
      const result = CascadeTransforms.applyTransform(["a", "b"], {
        type: "add_param",
        position: -1,
        defaultValue: "null",
      })
      expect(result).toEqual(["a", "b", "null"])
    })

    test("add_param inserts at position", () => {
      const result = CascadeTransforms.applyTransform(["a", "b"], {
        type: "add_param",
        position: 1,
        defaultValue: '"new"',
      })
      expect(result).toEqual(["a", '"new"', "b"])
    })

    test("remove_param removes at position", () => {
      const result = CascadeTransforms.applyTransform(["a", "b", "c"], {
        type: "remove_param",
        position: 1,
      })
      expect(result).toEqual(["a", "c"])
    })

    test("remove_param returns null for out of bounds", () => {
      const result = CascadeTransforms.applyTransform(["a"], {
        type: "remove_param",
        position: 5,
      })
      expect(result).toBeNull()
    })

    test("reorder_params reorders", () => {
      const result = CascadeTransforms.applyTransform(["a", "b", "c"], {
        type: "reorder_params",
        newOrder: [2, 0, 1],
      })
      expect(result).toEqual(["c", "a", "b"])
    })

    test("reorder_params returns null for wrong length", () => {
      const result = CascadeTransforms.applyTransform(["a", "b"], {
        type: "reorder_params",
        newOrder: [0],
      })
      expect(result).toBeNull()
    })

    test("change_type returns null (informational only)", () => {
      const result = CascadeTransforms.applyTransform(["a"], {
        type: "change_type",
        description: "Changed return type",
      })
      expect(result).toBeNull()
    })
  })

  describe("transformCallSites", () => {
    test("transforms simple call sites", () => {
      const content = `const x = foo(1, 2)\nconst y = foo(3, 4)`
      const { results, newContent } = CascadeTransforms.transformCallSites(content, "foo", {
        type: "add_param",
        position: -1,
        defaultValue: "null",
      })

      expect(results.length).toBe(2)
      expect(newContent).toContain("foo(1, 2, null)")
      expect(newContent).toContain("foo(3, 4, null)")
    })

    test("does not modify non-matching calls", () => {
      const content = `const x = bar(1, 2)`
      const { results, newContent } = CascadeTransforms.transformCallSites(content, "foo", {
        type: "add_param",
        position: -1,
        defaultValue: "null",
      })

      expect(results.length).toBe(0)
      expect(newContent).toBe(content)
    })

    test("handles remove_param", () => {
      const content = `const x = foo(a, b, c)`
      const { results, newContent } = CascadeTransforms.transformCallSites(content, "foo", {
        type: "remove_param",
        position: 1,
      })

      expect(results.length).toBe(1)
      expect(newContent).toContain("foo(a, c)")
    })

    test("preserves lines without calls", () => {
      const content = `// comment\nconst x = foo(1)\n// another`
      const { newContent } = CascadeTransforms.transformCallSites(content, "foo", {
        type: "add_param",
        position: -1,
        defaultValue: "null",
      })

      expect(newContent).toContain("// comment")
      expect(newContent).toContain("// another")
    })

    test("handles nested calls", () => {
      const content = `const x = foo(bar(1), 2)`
      const { results, newContent } = CascadeTransforms.transformCallSites(content, "foo", {
        type: "add_param",
        position: -1,
        defaultValue: "true",
      })

      expect(results.length).toBe(1)
      expect(newContent).toContain("foo(bar(1), 2, true)")
    })

    test("change_type produces no edits", () => {
      const content = `const x = foo(1)`
      const { results, newContent } = CascadeTransforms.transformCallSites(content, "foo", {
        type: "change_type",
        description: "Changed return type",
      })

      expect(results.length).toBe(0)
      expect(newContent).toBe(content)
    })
  })
})

describe("Cascade", () => {
  let tempDir: string

  beforeEach(async () => {
    Cascade.clearAll()
    tempDir = await mkdtemp(join(tmpdir(), "cascade-test-"))
  })

  test("plan finds and transforms call sites", async () => {
    const file1 = join(tempDir, "a.ts")
    const file2 = join(tempDir, "b.ts")
    await writeFile(file1, `import { greet } from "./greet"\nconst x = greet("Alice")\n`)
    await writeFile(file2, `import { greet } from "./greet"\nconst y = greet("Bob")\n`)

    const plan = await Cascade.plan("greet", {
      type: "add_param",
      position: -1,
      defaultValue: '"en"',
      name: "locale",
    }, [file1, file2])

    expect(plan.affectedFiles.length).toBe(2)
    expect(plan.status).toBe("planned")

    const totalSites = plan.affectedFiles.reduce((s, f) => s + f.callSites.length, 0)
    expect(totalSites).toBe(2)
  })

  test("preview shows readable diff", async () => {
    const file = join(tempDir, "c.ts")
    await writeFile(file, `const r = compute(1, 2)\n`)

    const plan = await Cascade.plan("compute", {
      type: "add_param",
      position: -1,
      defaultValue: "true",
    }, [file])

    const output = Cascade.preview(plan.id)
    expect(output).toContain("compute")
    expect(output).toContain("1 file(s)")
  })

  test("apply writes files to disk", async () => {
    const file = join(tempDir, "d.ts")
    await writeFile(file, `const r = process(input)\n`)

    const plan = await Cascade.plan("process", {
      type: "add_param",
      position: -1,
      defaultValue: "{}",
    }, [file])

    const count = await Cascade.apply(plan.id)
    expect(count).toBe(1)

    const content = await readFile(file, "utf-8")
    expect(content).toContain("process(input, {})")
  })

  test("apply sets status to applied", async () => {
    const file = join(tempDir, "e.ts")
    await writeFile(file, `const x = fn(a)\n`)

    const plan = await Cascade.plan("fn", {
      type: "add_param",
      position: 0,
      defaultValue: "null",
    }, [file])

    await Cascade.apply(plan.id)
    expect(Cascade.get(plan.id)!.status).toBe("applied")
  })

  test("apply rejects non-planned status", async () => {
    const file = join(tempDir, "f.ts")
    await writeFile(file, `const x = fn(a)\n`)

    const plan = await Cascade.plan("fn", {
      type: "add_param",
      position: -1,
      defaultValue: "null",
    }, [file])

    await Cascade.apply(plan.id)
    expect(Cascade.apply(plan.id)).rejects.toThrow()
  })

  test("list and format work", async () => {
    const file = join(tempDir, "g.ts")
    await writeFile(file, `const x = fn(a)\n`)

    await Cascade.plan("fn", { type: "add_param", position: -1, defaultValue: "null" }, [file])

    expect(Cascade.list().length).toBe(1)
    expect(Cascade.format(Cascade.list()[0].id)).toContain("fn")
  })

  test("plan with no matching calls produces empty plan", async () => {
    const file = join(tempDir, "h.ts")
    await writeFile(file, `const x = otherFn(a)\n`)

    const plan = await Cascade.plan("nonExistent", {
      type: "add_param",
      position: -1,
      defaultValue: "null",
    }, [file])

    expect(plan.affectedFiles.length).toBe(0)
  })
})
