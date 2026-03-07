import { describe, expect, test } from "bun:test"

/**
 * Tests for diff parsing logic used by the diff tool.
 * Since the diff tool delegates to git, we test the internal parsing functions
 * that extract structured data from unified diff output.
 */
describe("diff.parsing", () => {
  test("parseDiffStats counts files, additions, deletions", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,5 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
+const d = 5
 const e = 6
diff --git a/src/bar.ts b/src/bar.ts
index 111..222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,3 +10,2 @@
 export function bar() {
-  return 1
 }
`
    const stats = parseDiffStats(diff)
    expect(stats.files).toBe(2)
    expect(stats.additions).toBe(3) // +const b = 3, +const c = 4, +const d = 5
    expect(stats.deletions).toBe(2) // -const b = 2, -return 1
  })

  test("parseDiffStats handles empty diff", () => {
    const stats = parseDiffStats("")
    expect(stats.files).toBe(0)
    expect(stats.additions).toBe(0)
    expect(stats.deletions).toBe(0)
  })

  test("parseHunks extracts individual hunks", () => {
    const diff = `@@ -1,3 +1,4 @@
 line1
-old line
+new line
+added line
 line3
@@ -10,2 +11,3 @@
 line10
+inserted
 line11
`
    const hunks = parseHunks(diff)
    expect(hunks.length).toBe(2)
    expect(hunks[0].stats.additions).toBe(2)
    expect(hunks[0].stats.deletions).toBe(1)
    expect(hunks[1].stats.additions).toBe(1)
    expect(hunks[1].stats.deletions).toBe(0)
  })

  test("parseHunks handles single hunk", () => {
    const diff = `@@ -5,3 +5,3 @@
 context
-removed
+added
 context
`
    const hunks = parseHunks(diff)
    expect(hunks.length).toBe(1)
    expect(hunks[0].stats.additions).toBe(1)
    expect(hunks[0].stats.deletions).toBe(1)
    expect(hunks[0].content).toContain("@@ -5,3 +5,3 @@")
  })

  test("parseHunks returns empty array for no hunks", () => {
    const hunks = parseHunks("no hunks here")
    expect(hunks.length).toBe(0)
  })

  test("parseDiffStats ignores --- and +++ lines", () => {
    const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-old
+new
`
    const stats = parseDiffStats(diff)
    // Should count +new and -old, but NOT +++ or ---
    expect(stats.additions).toBe(1)
    expect(stats.deletions).toBe(1)
  })
})

// Duplicated parsing logic from diff tool for unit testing without tool infrastructure
function parseDiffStats(diff: string): { files: number; additions: number; deletions: number } {
  const files = new Set<string>()
  let additions = 0
  let deletions = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.+)$/)
      if (match) files.add(match[1])
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++
    }
  }
  return { files: files.size, additions, deletions }
}

function parseHunks(diff: string): { content: string; stats: { additions: number; deletions: number } }[] {
  const hunks: { content: string; stats: { additions: number; deletions: number } }[] = []
  const lines = diff.split("\n")
  let currentHunk: string[] = []
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHunk.length > 0) {
        hunks.push({ content: currentHunk.join("\n"), stats: { additions, deletions } })
      }
      currentHunk = [line]
      additions = 0
      deletions = 0
    } else if (currentHunk.length > 0) {
      currentHunk.push(line)
      if (line.startsWith("+") && !line.startsWith("+++")) additions++
      if (line.startsWith("-") && !line.startsWith("---")) deletions++
    }
  }
  if (currentHunk.length > 0) {
    hunks.push({ content: currentHunk.join("\n"), stats: { additions, deletions } })
  }
  return hunks
}
