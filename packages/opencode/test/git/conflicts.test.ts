import { describe, expect, test } from "bun:test"
import { Conflicts } from "../../src/git/conflicts"

const SIMPLE_CONFLICT = [
  "line before",
  "<<<<<<< HEAD",
  "our change",
  "=======",
  "their change",
  ">>>>>>> feature",
  "line after",
].join("\n")

const THREE_WAY_CONFLICT = [
  "line before",
  "<<<<<<< HEAD",
  "our version",
  "||||||| base",
  "original version",
  "=======",
  "their version",
  ">>>>>>> feature",
  "line after",
].join("\n")

const MULTI_CONFLICT = [
  "start",
  "<<<<<<< HEAD",
  "our first",
  "=======",
  "their first",
  ">>>>>>> feature",
  "middle",
  "<<<<<<< HEAD",
  "our second",
  "=======",
  "their second",
  ">>>>>>> feature",
  "end",
].join("\n")

describe("conflicts.parse", () => {
  test("parses simple conflict", () => {
    const hunks = Conflicts.parse(SIMPLE_CONFLICT)
    expect(hunks.length).toBe(1)
    expect(hunks[0].ours).toBe("our change")
    expect(hunks[0].theirs).toBe("their change")
    expect(hunks[0].base).toBeUndefined()
    expect(hunks[0].startLine).toBe(2)
    expect(hunks[0].endLine).toBe(6)
  })

  test("parses three-way conflict with base", () => {
    const hunks = Conflicts.parse(THREE_WAY_CONFLICT)
    expect(hunks.length).toBe(1)
    expect(hunks[0].ours).toBe("our version")
    expect(hunks[0].theirs).toBe("their version")
    expect(hunks[0].base).toBe("original version")
  })

  test("parses multiple conflicts", () => {
    const hunks = Conflicts.parse(MULTI_CONFLICT)
    expect(hunks.length).toBe(2)
    expect(hunks[0].ours).toBe("our first")
    expect(hunks[0].theirs).toBe("their first")
    expect(hunks[1].ours).toBe("our second")
    expect(hunks[1].theirs).toBe("their second")
  })

  test("returns empty for no conflicts", () => {
    const hunks = Conflicts.parse("just normal content\nno conflicts here")
    expect(hunks.length).toBe(0)
  })

  test("captures context lines", () => {
    const hunks = Conflicts.parse(SIMPLE_CONFLICT)
    expect(hunks[0].contextBefore).toContain("line before")
    expect(hunks[0].contextAfter).toContain("line after")
  })
})

describe("conflicts.resolve", () => {
  test("resolves with ours strategy", () => {
    const result = Conflicts.resolve(SIMPLE_CONFLICT, 0, "ours")
    expect(result).toContain("our change")
    expect(result).not.toContain("their change")
    expect(result).not.toContain("<<<<<<<")
    expect(result).toContain("line before")
    expect(result).toContain("line after")
  })

  test("resolves with theirs strategy", () => {
    const result = Conflicts.resolve(SIMPLE_CONFLICT, 0, "theirs")
    expect(result).toContain("their change")
    expect(result).not.toContain("our change")
  })

  test("resolves with both strategy", () => {
    const result = Conflicts.resolve(SIMPLE_CONFLICT, 0, "both")
    expect(result).toContain("our change")
    expect(result).toContain("their change")
  })

  test("resolves with custom content", () => {
    const result = Conflicts.resolve(SIMPLE_CONFLICT, 0, "custom", "merged content")
    expect(result).toContain("merged content")
    expect(result).not.toContain("our change")
    expect(result).not.toContain("their change")
  })

  test("throws for invalid hunk index", () => {
    expect(() => Conflicts.resolve(SIMPLE_CONFLICT, 5, "ours")).toThrow("Invalid hunk index")
  })

  test("throws for custom strategy without content", () => {
    expect(() => Conflicts.resolve(SIMPLE_CONFLICT, 0, "custom")).toThrow("Custom content required")
  })
})

describe("conflicts.resolveAll", () => {
  test("resolves all conflicts with one strategy", () => {
    const result = Conflicts.resolveAll(MULTI_CONFLICT, "ours")
    expect(result).toContain("our first")
    expect(result).toContain("our second")
    expect(result).not.toContain("their first")
    expect(result).not.toContain("their second")
    expect(result).not.toContain("<<<<<<<")
    expect(result).toContain("start")
    expect(result).toContain("middle")
    expect(result).toContain("end")
  })
})

describe("conflicts.applyResolutions", () => {
  test("applies mixed resolutions", () => {
    const result = Conflicts.applyResolutions(MULTI_CONFLICT, [
      { hunkIndex: 0, strategy: "ours" },
      { hunkIndex: 1, strategy: "theirs" },
    ])
    expect(result).toContain("our first")
    expect(result).toContain("their second")
    expect(result).not.toContain("their first")
    expect(result).not.toContain("our second")
  })
})

describe("conflicts.suggest", () => {
  test("suggests theirs when ours is empty", () => {
    const hunk: Conflicts.ConflictHunk = {
      startLine: 1,
      endLine: 5,
      ours: "",
      theirs: "new content",
      contextBefore: [],
      contextAfter: [],
    }
    const suggestion = Conflicts.suggest(hunk)
    expect(suggestion.strategy).toBe("theirs")
    expect(suggestion.confidence).toBeGreaterThan(0.8)
  })

  test("suggests ours when theirs is empty", () => {
    const hunk: Conflicts.ConflictHunk = {
      startLine: 1,
      endLine: 5,
      ours: "our content",
      theirs: "",
      contextBefore: [],
      contextAfter: [],
    }
    const suggestion = Conflicts.suggest(hunk)
    expect(suggestion.strategy).toBe("ours")
    expect(suggestion.confidence).toBeGreaterThan(0.8)
  })

  test("suggests theirs when ours matches base (unchanged)", () => {
    const hunk: Conflicts.ConflictHunk = {
      startLine: 1,
      endLine: 5,
      ours: "original",
      theirs: "updated",
      base: "original",
      contextBefore: [],
      contextAfter: [],
    }
    const suggestion = Conflicts.suggest(hunk)
    expect(suggestion.strategy).toBe("theirs")
    expect(suggestion.confidence).toBeGreaterThan(0.7)
  })

  test("suggests both with low confidence for equal changes", () => {
    const hunk: Conflicts.ConflictHunk = {
      startLine: 1,
      endLine: 5,
      ours: "change A",
      theirs: "change B",
      contextBefore: [],
      contextAfter: [],
    }
    const suggestion = Conflicts.suggest(hunk)
    expect(suggestion.strategy).toBe("both")
    expect(suggestion.confidence).toBeLessThan(0.5)
  })
})

describe("conflicts.format", () => {
  test("formats empty conflicts", () => {
    expect(Conflicts.format([])).toBe("No conflicts found.")
  })

  test("formats conflict hunks with suggestions", () => {
    const hunks = Conflicts.parse(SIMPLE_CONFLICT)
    const output = Conflicts.format(hunks)
    expect(output).toContain("Conflict #1")
    expect(output).toContain("OURS")
    expect(output).toContain("THEIRS")
    expect(output).toContain("Suggestion:")
    expect(output).toContain("confidence")
  })
})
