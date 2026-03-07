import { describe, expect, test, beforeEach } from "bun:test"
import { Refactor } from "../../src/refactor"
import { RefactorOps } from "../../src/refactor/operations"
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"

function createTestDir(files: Record<string, string>): string {
  const dir = join(tmpdir(), `refactor-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true }) } catch {}
}

describe("RefactorOps", () => {
  describe("renameSymbol", () => {
    test("renames across files", async () => {
      const dir = createTestDir({
        "a.ts": 'export function oldName() { return 1; }',
        "b.ts": 'import { oldName } from "./a";\noldName();',
        "c.ts": 'const x = "unrelated";',
      })

      const edits = await RefactorOps.renameSymbol("oldName", "newName", [
        join(dir, "a.ts"),
        join(dir, "b.ts"),
        join(dir, "c.ts"),
      ])

      expect(edits.length).toBe(2) // a.ts and b.ts, not c.ts
      expect(edits[0].newContent).toContain("newName")
      expect(edits[0].newContent).not.toContain("oldName")
      expect(edits[1].newContent).toContain("newName")

      cleanup(dir)
    })

    test("uses word boundaries", async () => {
      const dir = createTestDir({
        "a.ts": 'const isValid = true;\nconst isValidated = false;',
      })

      const edits = await RefactorOps.renameSymbol("isValid", "isChecked", [join(dir, "a.ts")])
      expect(edits.length).toBe(1)
      expect(edits[0].newContent).toContain("isChecked")
      expect(edits[0].newContent).toContain("isValidated") // Not renamed
      expect(edits[0].newContent).not.toContain("isCheckeded")

      cleanup(dir)
    })

    test("handles no matches", async () => {
      const dir = createTestDir({
        "a.ts": 'const x = 1;',
      })

      const edits = await RefactorOps.renameSymbol("notFound", "other", [join(dir, "a.ts")])
      expect(edits.length).toBe(0)

      cleanup(dir)
    })
  })

  describe("extractFunction", () => {
    test("extracts lines into a new function", async () => {
      const dir = createTestDir({
        "code.ts": `function main() {
  const x = 1;
  const y = 2;
  const sum = x + y;
  console.log(sum);
  return sum;
}`,
      })

      const edits = await RefactorOps.extractFunction(
        join(dir, "code.ts"), 3, 4, "computeSum",
      )

      expect(edits.length).toBe(1)
      expect(edits[0].newContent).toContain("computeSum()")
      expect(edits[0].newContent).toContain("function computeSum()")

      cleanup(dir)
    })
  })
})

describe("Refactor", () => {
  beforeEach(() => {
    Refactor.clearAll()
  })

  describe("plan lifecycle", () => {
    test("creates a plan", () => {
      const p = Refactor.plan("Test refactoring")
      expect(p.id.length).toBeGreaterThan(0)
      expect(p.description).toBe("Test refactoring")
      expect(p.status).toBe("planned")
      expect(p.edits.length).toBe(0)
    })

    test("adds edits to plan", () => {
      const p = Refactor.plan("Add edits")
      Refactor.addEdit(p.id, {
        filePath: "/tmp/test.ts",
        oldContent: "const x = 1;",
        newContent: "const x = 2;",
        description: "Update x",
      })

      const updated = Refactor.get(p.id)!
      expect(updated.edits.length).toBe(1)
      expect(updated.edits[0].description).toBe("Update x")
    })

    test("validates plan", async () => {
      const dir = createTestDir({
        "a.ts": "const x = 1;",
      })

      const p = Refactor.plan("Validate test")
      Refactor.addEdit(p.id, {
        filePath: join(dir, "a.ts"),
        oldContent: "const x = 1;",
        newContent: "const x = 2;",
        description: "Update x",
      })

      const validated = await Refactor.validate(p.id)
      expect(validated.status).toBe("validated")
      expect(validated.validation!.success).toBe(true)

      cleanup(dir)
    })

    test("detects external changes on validate", async () => {
      const dir = createTestDir({
        "a.ts": "const x = 1;",
      })

      const p = Refactor.plan("Conflict test")
      Refactor.addEdit(p.id, {
        filePath: join(dir, "a.ts"),
        oldContent: "const x = WRONG;", // Doesn't match actual file
        newContent: "const x = 2;",
        description: "Update x",
      })

      const validated = await Refactor.validate(p.id)
      expect(validated.validation!.success).toBe(false)
      expect(validated.validation!.errors.length).toBeGreaterThan(0)

      cleanup(dir)
    })

    test("applies edits atomically", async () => {
      const dir = createTestDir({
        "a.ts": "const x = 1;",
        "b.ts": "const y = 2;",
      })

      const p = Refactor.plan("Apply test")
      Refactor.addEdit(p.id, {
        filePath: join(dir, "a.ts"),
        oldContent: "const x = 1;",
        newContent: "const x = 10;",
        description: "Update x",
      })
      Refactor.addEdit(p.id, {
        filePath: join(dir, "b.ts"),
        oldContent: "const y = 2;",
        newContent: "const y = 20;",
        description: "Update y",
      })

      await Refactor.apply(p.id)

      expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("const x = 10;")
      expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("const y = 20;")

      cleanup(dir)
    })

    test("rolls back applied edits", async () => {
      const dir = createTestDir({
        "a.ts": "original content",
      })

      const p = Refactor.plan("Rollback test")
      Refactor.addEdit(p.id, {
        filePath: join(dir, "a.ts"),
        oldContent: "original content",
        newContent: "modified content",
        description: "Modify",
      })

      await Refactor.apply(p.id)
      expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("modified content")

      await Refactor.rollback(p.id)
      expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("original content")

      cleanup(dir)
    })

    test("cannot rollback a non-applied plan", () => {
      const p = Refactor.plan("Not applied")
      expect(Refactor.rollback(p.id)).rejects.toThrow("Cannot rollback")
    })

    test("cannot add edits to applied plan", async () => {
      const dir = createTestDir({ "a.ts": "x" })
      const p = Refactor.plan("Applied")
      Refactor.addEdit(p.id, { filePath: join(dir, "a.ts"), oldContent: "x", newContent: "y", description: "edit" })
      await Refactor.apply(p.id)

      expect(() => {
        Refactor.addEdit(p.id, { filePath: "/tmp/z", oldContent: "", newContent: "", description: "" })
      }).toThrow("Cannot add edits")

      cleanup(dir)
    })
  })

  describe("high-level operations", () => {
    test("renameSymbol creates a plan with edits", async () => {
      const dir = createTestDir({
        "a.ts": "export function oldFunc() {}",
        "b.ts": 'import { oldFunc } from "./a";\noldFunc();',
      })

      const p = await Refactor.renameSymbol("oldFunc", "newFunc", [
        join(dir, "a.ts"),
        join(dir, "b.ts"),
      ])

      expect(p.edits.length).toBe(2)
      expect(p.description).toContain("oldFunc")
      expect(p.description).toContain("newFunc")

      cleanup(dir)
    })

    test("extractFunction creates a plan", async () => {
      const dir = createTestDir({
        "code.ts": "function main() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}",
      })

      const p = await Refactor.extractFunction(join(dir, "code.ts"), 2, 3, "setup")
      expect(p.edits.length).toBe(1)

      cleanup(dir)
    })
  })

  describe("diff", () => {
    test("generates diff preview", () => {
      const p = Refactor.plan("Diff test")
      Refactor.addEdit(p.id, {
        filePath: "/tmp/test.ts",
        oldContent: "const x = 1;\nconst y = 2;",
        newContent: "const x = 10;\nconst y = 2;",
        description: "Update x",
      })

      const d = Refactor.diff(p.id)
      expect(d).toContain("Diff test")
      expect(d).toContain("/tmp/test.ts")
    })
  })

  describe("list", () => {
    test("lists all plans", () => {
      Refactor.plan("Plan A")
      Refactor.plan("Plan B")
      expect(Refactor.list().length).toBe(2)
    })

    test("empty when no plans", () => {
      expect(Refactor.list().length).toBe(0)
    })
  })

  describe("formatPlan", () => {
    test("formats plan summary", () => {
      const p = Refactor.plan("Format test")
      Refactor.addEdit(p.id, {
        filePath: "/tmp/a.ts",
        oldContent: "x",
        newContent: "y",
        description: "Change x to y",
      })

      const formatted = Refactor.formatPlan(p)
      expect(formatted).toContain("Format test")
      expect(formatted).toContain("planned")
      expect(formatted).toContain("Change x to y")
    })
  })
})
