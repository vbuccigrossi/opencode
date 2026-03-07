import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import { Staging } from "../../src/staging"
import { writeFile, readFile, mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"

describe("Staging", () => {
  beforeEach(() => {
    Staging.clearAll()
  })

  describe("create", () => {
    test("creates a staging area with open status", () => {
      const area = Staging.create("Test changeset")
      expect(area.id).toMatch(/^stage-/)
      expect(area.description).toBe("Test changeset")
      expect(area.status).toBe("open")
      expect(area.edits).toEqual([])
    })

    test("assigns unique IDs", () => {
      const a1 = Staging.create("first")
      const a2 = Staging.create("second")
      expect(a1.id).not.toBe(a2.id)
    })
  })

  describe("stageWithOriginal", () => {
    test("stages an edit", () => {
      const area = Staging.create("test")
      const edit = Staging.stageWithOriginal(area.id, "/tmp/a.ts", "old", "new", "edit a")

      expect(edit.filePath).toBe("/tmp/a.ts")
      expect(edit.original).toBe("old")
      expect(edit.proposed).toBe("new")
      expect(edit.description).toBe("edit a")
    })

    test("replaces existing edit for same file", () => {
      const area = Staging.create("test")
      Staging.stageWithOriginal(area.id, "/tmp/a.ts", "old", "new1", "first")
      Staging.stageWithOriginal(area.id, "/tmp/a.ts", "old", "new2", "second")

      const fetched = Staging.get(area.id)!
      expect(fetched.edits.length).toBe(1)
      expect(fetched.edits[0].proposed).toBe("new2")
    })

    test("throws for unknown area", () => {
      expect(() => Staging.stageWithOriginal("unknown", "/tmp/a.ts", "", "", "")).toThrow()
    })

    test("throws for non-open area", () => {
      const area = Staging.create("test")
      Staging.discard(area.id)
      expect(() => Staging.stageWithOriginal(area.id, "/tmp/a.ts", "", "", "")).toThrow()
    })
  })

  describe("get and list", () => {
    test("get returns area by ID", () => {
      const area = Staging.create("test")
      expect(Staging.get(area.id)).toBeDefined()
      expect(Staging.get(area.id)!.id).toBe(area.id)
    })

    test("get returns undefined for unknown ID", () => {
      expect(Staging.get("nonexistent")).toBeUndefined()
    })

    test("list returns all areas", () => {
      Staging.create("a")
      Staging.create("b")
      expect(Staging.list().length).toBe(2)
    })
  })

  describe("diff", () => {
    test("returns message for empty staging", () => {
      const area = Staging.create("test")
      const d = Staging.diff(area.id)
      expect(d).toContain("No staged edits")
    })

    test("generates diff for staged edits", () => {
      const area = Staging.create("test")
      Staging.stageWithOriginal(area.id, "src/a.ts", "const x = 1\n", "const x = 2\n", "update x")

      const d = Staging.diff(area.id)
      expect(d).toContain("--- a/src/a.ts")
      expect(d).toContain("+++ b/src/a.ts")
    })

    test("throws for unknown area", () => {
      expect(() => Staging.diff("nonexistent")).toThrow()
    })
  })

  describe("apply", () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "staging-test-"))
    })

    test("writes files to disk", async () => {
      const filePath = join(tempDir, "test.ts")
      await writeFile(filePath, "old content")

      const area = Staging.create("test")
      Staging.stageWithOriginal(area.id, filePath, "old content", "new content", "update")

      const count = await Staging.apply(area.id)
      expect(count).toBe(1)

      const content = await readFile(filePath, "utf-8")
      expect(content).toBe("new content")
    })

    test("marks area as applied", async () => {
      const area = Staging.create("test")
      await Staging.apply(area.id)

      expect(Staging.get(area.id)!.status).toBe("applied")
    })

    test("throws for non-open area", async () => {
      const area = Staging.create("test")
      Staging.discard(area.id)
      expect(Staging.apply(area.id)).rejects.toThrow()
    })

    // Cleanup
    afterAll(async () => {
      try { await rm(tempDir, { recursive: true }) } catch {}
    })
  })

  describe("discard", () => {
    test("marks area as discarded", () => {
      const area = Staging.create("test")
      Staging.discard(area.id)
      expect(Staging.get(area.id)!.status).toBe("discarded")
    })

    test("throws for unknown area", () => {
      expect(() => Staging.discard("nonexistent")).toThrow()
    })
  })

  describe("unstage", () => {
    test("removes a file from staging", () => {
      const area = Staging.create("test")
      Staging.stageWithOriginal(area.id, "/tmp/a.ts", "", "a", "a")
      Staging.stageWithOriginal(area.id, "/tmp/b.ts", "", "b", "b")
      expect(Staging.get(area.id)!.edits.length).toBe(2)

      Staging.unstage(area.id, "/tmp/a.ts")
      expect(Staging.get(area.id)!.edits.length).toBe(1)
      expect(Staging.get(area.id)!.edits[0].filePath).toBe("/tmp/b.ts")
    })

    test("throws for non-open area", () => {
      const area = Staging.create("test")
      Staging.discard(area.id)
      expect(() => Staging.unstage(area.id, "/tmp/a.ts")).toThrow()
    })
  })

  describe("format", () => {
    test("formats staging area summary", () => {
      const area = Staging.create("refactor imports")
      Staging.stageWithOriginal(area.id, "src/a.ts", "line1\nline2\n", "line1\nline2\nline3\n", "add import")

      const output = Staging.format(area.id)
      expect(output).toContain("refactor imports")
      expect(output).toContain("src/a.ts")
      expect(output).toContain("+1 lines")
    })

    test("returns message for unknown area", () => {
      const output = Staging.format("nonexistent")
      expect(output).toContain("not found")
    })
  })

  describe("clearAll", () => {
    test("removes all staging areas", () => {
      Staging.create("a")
      Staging.create("b")
      Staging.clearAll()
      expect(Staging.list().length).toBe(0)
    })
  })
})
