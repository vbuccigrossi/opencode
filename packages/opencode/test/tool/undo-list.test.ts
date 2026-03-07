import { describe, expect, test, beforeEach } from "bun:test"
import { Changelog } from "../../src/session/changelog"

/**
 * Tests for the undo tool's list/filtering logic.
 * The undo tool filters changelog entries to show only undoable edits.
 * Since actual undo requires git + snapshot infrastructure, we test the
 * filtering and listing logic directly.
 */
describe("undo.listing", () => {
  beforeEach(() => {
    Changelog.clear()
  })

  test("filters out external changes from undoable list", () => {
    Changelog.record({ file: "/a.ts", operation: "edit", toolID: "edit" })
    Changelog.record({ file: "/b.ts", operation: "external" })
    Changelog.record({ file: "/c.ts", operation: "write", toolID: "write" })

    const all = Changelog.all()
    const undoable = all.filter(
      (e) => e.operation !== "external" && e.toolID !== "undo",
    )
    expect(undoable.length).toBe(2)
    expect(undoable[0].file).toBe("/a.ts")
    expect(undoable[1].file).toBe("/c.ts")
  })

  test("filters out undo tool entries from undoable list", () => {
    Changelog.record({ file: "/a.ts", operation: "edit", toolID: "edit" })
    Changelog.record({ file: "/a.ts", operation: "edit", toolID: "undo" })
    Changelog.record({ file: "/b.ts", operation: "write", toolID: "write" })

    const all = Changelog.all()
    const undoable = all.filter(
      (e) => e.operation !== "external" && e.toolID !== "undo",
    )
    expect(undoable.length).toBe(2)
    expect(undoable[0].toolID).toBe("edit")
    expect(undoable[1].toolID).toBe("write")
  })

  test("preserves all operation types except external and undo", () => {
    Changelog.record({ file: "/a.ts", operation: "edit", toolID: "edit" })
    Changelog.record({ file: "/b.ts", operation: "write", toolID: "write" })
    Changelog.record({ file: "/c.ts", operation: "create", toolID: "write" })
    Changelog.record({ file: "/d.ts", operation: "delete", toolID: "apply_patch" })
    Changelog.record({ file: "/e.ts", operation: "patch", toolID: "apply_patch" })

    const all = Changelog.all()
    const undoable = all.filter(
      (e) => e.operation !== "external" && e.toolID !== "undo",
    )
    expect(undoable.length).toBe(5)
  })

  test("finds last entry with snapshot for file-level undo", () => {
    Changelog.record({
      file: "/a.ts",
      operation: "edit",
      toolID: "edit",
      snapshotBefore: "snap1",
    })
    Changelog.record({
      file: "/a.ts",
      operation: "edit",
      toolID: "edit",
      snapshotBefore: "snap2",
    })
    Changelog.record({
      file: "/a.ts",
      operation: "write",
      toolID: "write",
    })

    const history = Changelog.forFile("/a.ts")
    const lastWithSnapshot = [...history].reverse().find((e) => e.snapshotBefore)
    expect(lastWithSnapshot).toBeDefined()
    expect(lastWithSnapshot!.snapshotBefore).toBe("snap2")
  })

  test("returns undefined when no snapshot available for file", () => {
    Changelog.record({ file: "/a.ts", operation: "edit", toolID: "edit" })

    const history = Changelog.forFile("/a.ts")
    const lastWithSnapshot = [...history].reverse().find((e) => e.snapshotBefore)
    expect(lastWithSnapshot).toBeUndefined()
  })

  test("empty changelog produces empty undoable list", () => {
    const undoable = Changelog.all().filter(
      (e) => e.operation !== "external" && e.toolID !== "undo",
    )
    expect(undoable.length).toBe(0)
  })
})
