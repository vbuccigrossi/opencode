import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Changeset } from "../../src/changeset"
import fs from "fs"
import path from "path"
import os from "os"

describe("Changeset", () => {
  let tmpDir: string

  beforeEach(() => {
    Changeset.clear()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "changeset-"))
  })

  afterEach(() => {
    Changeset.clear()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("create", () => {
    test("creates a new change set", () => {
      const cs = Changeset.create("refactor-auth")
      expect(cs.name).toBe("refactor-auth")
      expect(cs.status).toBe("building")
      expect(cs.edits).toEqual([])
    })

    test("creates with description", () => {
      const cs = Changeset.create("fix-types", "Fix type errors across 5 files")
      expect(cs.description).toBe("Fix type errors across 5 files")
    })

    test("throws on duplicate name", () => {
      Changeset.create("test-cs")
      expect(() => Changeset.create("test-cs")).toThrow("already exists")
    })
  })

  describe("addEdit", () => {
    test("adds a file edit reading original from disk", () => {
      const file = path.join(tmpDir, "foo.ts")
      fs.writeFileSync(file, "const x = 1")

      Changeset.create("cs1")
      const cs = Changeset.addEdit("cs1", file, "const x = 2")
      expect(cs.edits.length).toBe(1)
      expect(cs.edits[0].original).toBe("const x = 1")
      expect(cs.edits[0].proposed).toBe("const x = 2")
      expect(cs.edits[0].isNew).toBe(false)
    })

    test("marks new files correctly", () => {
      const file = path.join(tmpDir, "new-file.ts")

      Changeset.create("cs1")
      const cs = Changeset.addEdit("cs1", file, "export const y = 42")
      expect(cs.edits[0].isNew).toBe(true)
      expect(cs.edits[0].original).toBe("")
    })

    test("uses explicit original content when provided", () => {
      Changeset.create("cs1")
      const cs = Changeset.addEdit("cs1", "/fake/path.ts", "new content", "old content")
      expect(cs.edits[0].original).toBe("old content")
      expect(cs.edits[0].proposed).toBe("new content")
    })

    test("replaces existing edit for same file", () => {
      const file = path.join(tmpDir, "replace.ts")
      fs.writeFileSync(file, "original")

      Changeset.create("cs1")
      Changeset.addEdit("cs1", file, "version1")
      const cs = Changeset.addEdit("cs1", file, "version2")
      expect(cs.edits.length).toBe(1)
      expect(cs.edits[0].proposed).toBe("version2")
    })

    test("throws when changeset is not building", () => {
      const file = path.join(tmpDir, "a.ts")
      fs.writeFileSync(file, "x")

      Changeset.create("cs1")
      Changeset.addEdit("cs1", file, "y")
      Changeset.apply("cs1")

      expect(() => Changeset.addEdit("cs1", file, "z")).toThrow("status is applied")
    })
  })

  describe("removeEdit", () => {
    test("removes a file from the change set", () => {
      Changeset.create("cs1")
      Changeset.addEdit("cs1", "/fake/a.ts", "a", "orig-a")
      Changeset.addEdit("cs1", "/fake/b.ts", "b", "orig-b")

      const cs = Changeset.removeEdit("cs1", "/fake/a.ts")
      expect(cs.edits.length).toBe(1)
      expect(cs.edits[0].filePath).toContain("b.ts")
    })
  })

  describe("preview", () => {
    test("shows diff hunks for all files", () => {
      Changeset.create("cs1")
      Changeset.addEdit("cs1", "/fake/a.ts", "line1\nline2\nline3", "line1\nold-line\nline3")
      Changeset.addEdit("cs1", "/fake/b.ts", "new-content", "")

      const hunks = Changeset.preview("cs1")
      expect(hunks.length).toBe(2)
    })

    test("marks new files in diff", () => {
      const file = path.join(tmpDir, "brand-new.ts")
      Changeset.create("cs1")
      Changeset.addEdit("cs1", file, "export const x = 1")

      const hunks = Changeset.preview("cs1")
      expect(hunks[0].isNew).toBe(true)
      expect(hunks[0].added).toBeGreaterThan(0)
      expect(hunks[0].removed).toBe(0)
    })
  })

  describe("formatPreview", () => {
    test("formats empty changeset", () => {
      Changeset.create("cs1")
      const output = Changeset.formatPreview("cs1")
      expect(output).toContain("No changes")
    })

    test("formats multi-file diff", () => {
      Changeset.create("cs1", "Fix auth flow")
      Changeset.addEdit("cs1", "/fake/auth.ts", "new auth", "old auth")
      Changeset.addEdit("cs1", "/fake/login.ts", "new login", "old login")

      const output = Changeset.formatPreview("cs1")
      expect(output).toContain("Fix auth flow")
      expect(output).toContain("Files: 2")
      expect(output).toContain("auth.ts")
      expect(output).toContain("login.ts")
    })
  })

  describe("apply", () => {
    test("writes all files atomically", () => {
      const file1 = path.join(tmpDir, "file1.ts")
      const file2 = path.join(tmpDir, "file2.ts")
      fs.writeFileSync(file1, "original1")
      fs.writeFileSync(file2, "original2")

      Changeset.create("cs1")
      Changeset.addEdit("cs1", file1, "new1")
      Changeset.addEdit("cs1", file2, "new2")

      const written = Changeset.apply("cs1")
      expect(written.length).toBe(2)
      expect(fs.readFileSync(file1, "utf-8")).toBe("new1")
      expect(fs.readFileSync(file2, "utf-8")).toBe("new2")
    })

    test("creates new files and parent directories", () => {
      const newFile = path.join(tmpDir, "sub", "dir", "new.ts")

      Changeset.create("cs1")
      Changeset.addEdit("cs1", newFile, "export const x = 1")

      Changeset.apply("cs1")
      expect(fs.readFileSync(newFile, "utf-8")).toBe("export const x = 1")
    })

    test("sets status to applied after success", () => {
      const file = path.join(tmpDir, "f.ts")
      fs.writeFileSync(file, "orig")

      Changeset.create("cs1")
      Changeset.addEdit("cs1", file, "new")
      Changeset.apply("cs1")

      const cs = Changeset.get("cs1")
      expect(cs?.status).toBe("applied")
    })

    test("throws on empty change set", () => {
      Changeset.create("cs1")
      expect(() => Changeset.apply("cs1")).toThrow("no edits")
    })

    test("throws on already applied change set", () => {
      const file = path.join(tmpDir, "f.ts")
      fs.writeFileSync(file, "orig")

      Changeset.create("cs1")
      Changeset.addEdit("cs1", file, "new")
      Changeset.apply("cs1")

      expect(() => Changeset.apply("cs1")).toThrow("status is applied")
    })
  })

  describe("rollback", () => {
    test("restores original content after apply", () => {
      const file1 = path.join(tmpDir, "r1.ts")
      const file2 = path.join(tmpDir, "r2.ts")
      fs.writeFileSync(file1, "orig1")
      fs.writeFileSync(file2, "orig2")

      Changeset.create("cs1")
      Changeset.addEdit("cs1", file1, "new1")
      Changeset.addEdit("cs1", file2, "new2")
      Changeset.apply("cs1")

      // Verify files changed
      expect(fs.readFileSync(file1, "utf-8")).toBe("new1")

      const restored = Changeset.rollback("cs1")
      expect(restored.length).toBe(2)
      expect(fs.readFileSync(file1, "utf-8")).toBe("orig1")
      expect(fs.readFileSync(file2, "utf-8")).toBe("orig2")
    })

    test("removes new files on rollback", () => {
      const newFile = path.join(tmpDir, "rollback-new.ts")

      Changeset.create("cs1")
      Changeset.addEdit("cs1", newFile, "content")
      Changeset.apply("cs1")
      expect(fs.existsSync(newFile)).toBe(true)

      Changeset.rollback("cs1")
      expect(fs.existsSync(newFile)).toBe(false)
    })

    test("throws when not applied", () => {
      Changeset.create("cs1")
      expect(() => Changeset.rollback("cs1")).toThrow("must be \"applied\"")
    })
  })

  describe("discard", () => {
    test("removes the change set", () => {
      Changeset.create("cs1")
      Changeset.discard("cs1")
      expect(Changeset.get("cs1")).toBeUndefined()
    })
  })

  describe("list", () => {
    test("lists all active change sets", () => {
      Changeset.create("cs1", "First")
      Changeset.create("cs2", "Second")

      const list = Changeset.list()
      expect(list.length).toBe(2)
      expect(list.map((s) => s.name).sort()).toEqual(["cs1", "cs2"])
    })

    test("returns empty when none exist", () => {
      expect(Changeset.list()).toEqual([])
    })
  })

  describe("get", () => {
    test("returns changeset by name", () => {
      Changeset.create("cs1")
      const cs = Changeset.get("cs1")
      expect(cs).toBeTruthy()
      expect(cs!.name).toBe("cs1")
    })

    test("returns undefined for non-existent", () => {
      expect(Changeset.get("nope")).toBeUndefined()
    })
  })
})
