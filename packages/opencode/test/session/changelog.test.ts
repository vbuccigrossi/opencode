import { describe, expect, test, beforeEach } from "bun:test"
import { Changelog } from "../../src/session/changelog"

describe("session.changelog", () => {
  beforeEach(() => {
    Changelog.clear()
  })

  test("records a change and retrieves it", () => {
    const entry = Changelog.record({
      file: "/project/src/foo.ts",
      operation: "edit",
      toolID: "edit",
      additions: 5,
      deletions: 2,
    })
    expect(entry.id).toBe(1)
    expect(entry.file).toBe("/project/src/foo.ts")
    expect(entry.operation).toBe("edit")
    expect(entry.additions).toBe(5)
    expect(entry.deletions).toBe(2)
    expect(entry.timestamp).toBeGreaterThan(0)
  })

  test("assigns monotonically increasing IDs", () => {
    const e1 = Changelog.record({ file: "/a.ts", operation: "edit" })
    const e2 = Changelog.record({ file: "/b.ts", operation: "write" })
    const e3 = Changelog.record({ file: "/c.ts", operation: "create" })
    expect(e1.id).toBe(1)
    expect(e2.id).toBe(2)
    expect(e3.id).toBe(3)
  })

  test("all() returns all entries in order", () => {
    Changelog.record({ file: "/a.ts", operation: "edit" })
    Changelog.record({ file: "/b.ts", operation: "write" })
    Changelog.record({ file: "/c.ts", operation: "create" })
    const all = Changelog.all()
    expect(all.length).toBe(3)
    expect(all[0].file).toBe("/a.ts")
    expect(all[2].file).toBe("/c.ts")
  })

  test("forFile() filters by absolute path", () => {
    Changelog.record({ file: "/project/src/foo.ts", operation: "edit" })
    Changelog.record({ file: "/project/src/bar.ts", operation: "edit" })
    Changelog.record({ file: "/project/src/foo.ts", operation: "write" })

    const fooChanges = Changelog.forFile("/project/src/foo.ts")
    expect(fooChanges.length).toBe(2)
    expect(fooChanges[0].operation).toBe("edit")
    expect(fooChanges[1].operation).toBe("write")
  })

  test("forSession() filters by sessionID", () => {
    Changelog.record({ file: "/a.ts", operation: "edit", sessionID: "s1" })
    Changelog.record({ file: "/b.ts", operation: "edit", sessionID: "s2" })
    Changelog.record({ file: "/c.ts", operation: "edit", sessionID: "s1" })

    const s1 = Changelog.forSession("s1")
    expect(s1.length).toBe(2)
    expect(s1[0].file).toBe("/a.ts")
    expect(s1[1].file).toBe("/c.ts")
  })

  test("affectedFiles() returns deduplicated file list", () => {
    Changelog.record({ file: "/a.ts", operation: "edit" })
    Changelog.record({ file: "/b.ts", operation: "edit" })
    Changelog.record({ file: "/a.ts", operation: "write" })

    const files = Changelog.affectedFiles()
    expect(files.length).toBe(2)
    expect(files).toContain("/a.ts")
    expect(files).toContain("/b.ts")
  })

  test("affectedFilesSince() returns files changed after a given ID", () => {
    Changelog.record({ file: "/a.ts", operation: "edit" })
    const marker = Changelog.record({ file: "/b.ts", operation: "edit" })
    Changelog.record({ file: "/c.ts", operation: "create" })
    Changelog.record({ file: "/d.ts", operation: "write" })

    const since = Changelog.affectedFilesSince(marker.id)
    expect(since.length).toBe(2)
    expect(since).toContain("/c.ts")
    expect(since).toContain("/d.ts")
  })

  test("lastForFile() returns the most recent entry", () => {
    Changelog.record({ file: "/a.ts", operation: "edit", summary: "first" })
    Changelog.record({ file: "/a.ts", operation: "write", summary: "second" })
    Changelog.record({ file: "/a.ts", operation: "edit", summary: "third" })

    const last = Changelog.lastForFile("/a.ts")
    expect(last).toBeDefined()
    expect(last!.summary).toBe("third")
  })

  test("lastForFile() returns undefined for unknown file", () => {
    expect(Changelog.lastForFile("/nonexistent.ts")).toBeUndefined()
  })

  test("summarize() aggregates stats", () => {
    Changelog.record({ file: "/a.ts", operation: "edit", additions: 10, deletions: 3 })
    Changelog.record({ file: "/b.ts", operation: "create", additions: 20, deletions: 0 })
    Changelog.record({ file: "/a.ts", operation: "edit", additions: 5, deletions: 2 })

    const summary = Changelog.summarize()
    expect(summary.files).toBe(2)
    expect(summary.additions).toBe(35)
    expect(summary.deletions).toBe(5)
    expect(summary.operations["edit"]).toBe(2)
    expect(summary.operations["create"]).toBe(1)
  })

  test("clear() resets all entries and counter", () => {
    Changelog.record({ file: "/a.ts", operation: "edit" })
    Changelog.record({ file: "/b.ts", operation: "edit" })
    Changelog.clear()

    expect(Changelog.all().length).toBe(0)
    const entry = Changelog.record({ file: "/c.ts", operation: "edit" })
    expect(entry.id).toBe(1) // Counter reset
  })

  test("defaults additions and deletions to 0", () => {
    const entry = Changelog.record({ file: "/a.ts", operation: "edit" })
    expect(entry.additions).toBe(0)
    expect(entry.deletions).toBe(0)
  })

  test("stores optional metadata fields", () => {
    const entry = Changelog.record({
      file: "/a.ts",
      operation: "edit",
      toolID: "edit",
      messageID: "msg123",
      sessionID: "sess456",
      snapshotBefore: "abc123",
      snapshotAfter: "def456",
      summary: "Changed function name",
    })
    expect(entry.toolID).toBe("edit")
    expect(entry.messageID).toBe("msg123")
    expect(entry.sessionID).toBe("sess456")
    expect(entry.snapshotBefore).toBe("abc123")
    expect(entry.snapshotAfter).toBe("def456")
    expect(entry.summary).toBe("Changed function name")
  })
})
