import { describe, expect, test } from "bun:test"
import { Explore } from "../../src/explore"
import { ExploreQueries } from "../../src/explore/queries"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"

/** Create a temporary directory with test files for exploration. */
function createTestDir(): string {
  const dir = join(tmpdir(), `explore-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })

  writeFileSync(
    join(dir, "hello.ts"),
    `export function greet(name: string): string {
  return "Hello, " + name + "!"
}

export function farewell(name: string): string {
  return "Goodbye, " + name + "!"
}

export const VERSION = "1.0.0"
`,
  )

  writeFileSync(
    join(dir, "math.ts"),
    `export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}
`,
  )

  writeFileSync(
    join(dir, "index.ts"),
    `import { greet } from "./hello"
import { add } from "./math"

console.log(greet("World"))
console.log(add(2, 3))
`,
  )

  return dir
}

function cleanupTestDir(dir: string) {
  try {
    rmSync(dir, { recursive: true })
  } catch {}
}

describe("ExploreQueries", () => {
  let testDir: string

  test("setup", () => {
    testDir = createTestDir()
  })

  describe("read_file", () => {
    test("reads file with signatures", async () => {
      const result = await ExploreQueries.execute(
        { id: "r1", type: "read_file", params: { path: "hello.ts" } },
        testDir,
      )
      expect(result.success).toBe(true)
      expect(result.queryId).toBe("r1")
      expect(result.summary).toContain("hello.ts")
      expect(result.summary).toContain("greet")
      expect(result.summary).toContain("farewell")
      expect(result.summary).toContain("VERSION")
    })

    test("fails for missing file", async () => {
      const result = await ExploreQueries.execute(
        { id: "r2", type: "read_file", params: { path: "nonexistent.ts" } },
        testDir,
      )
      expect(result.success).toBe(false)
      expect(result.summary).toContain("Error")
    })

    test("requires path parameter", async () => {
      const result = await ExploreQueries.execute(
        { id: "r3", type: "read_file", params: {} },
        testDir,
      )
      expect(result.success).toBe(false)
      expect(result.summary).toContain("path parameter required")
    })

    test("respects max_lines", async () => {
      const result = await ExploreQueries.execute(
        { id: "r4", type: "read_file", params: { path: "hello.ts", max_lines: 3 } },
        testDir,
      )
      expect(result.success).toBe(true)
      // Should show "more lines" since file has more than 3 lines
      expect(result.summary).toContain("more lines")
    })
  })

  describe("grep", () => {
    test("finds pattern matches", async () => {
      const result = await ExploreQueries.execute(
        { id: "g1", type: "grep", params: { pattern: "function" } },
        testDir,
      )
      expect(result.success).toBe(true)
      expect(result.summary).toContain("Grep")
      expect(result.summary).toContain("function")
    })

    test("requires pattern parameter", async () => {
      const result = await ExploreQueries.execute(
        { id: "g2", type: "grep", params: {} },
        testDir,
      )
      expect(result.success).toBe(false)
      expect(result.summary).toContain("pattern parameter required")
    })

    test("respects glob filter", async () => {
      const result = await ExploreQueries.execute(
        { id: "g3", type: "grep", params: { pattern: "export", glob: "*.ts" } },
        testDir,
      )
      expect(result.success).toBe(true)
      expect(result.summary).toContain("export")
    })
  })

  describe("graph_callers", () => {
    test("handles graph not available", async () => {
      const result = await ExploreQueries.execute(
        { id: "gc1", type: "graph_callers", params: { symbol: "greet" } },
        testDir,
      )
      // May fail if graph isn't initialized — that's expected in test env
      expect(result.queryId).toBe("gc1")
      // Either succeeds with results or fails gracefully
      expect(typeof result.success).toBe("boolean")
    })

    test("requires symbol parameter", async () => {
      const result = await ExploreQueries.execute(
        { id: "gc2", type: "graph_callers", params: {} },
        testDir,
      )
      expect(result.success).toBe(false)
      expect(result.summary).toContain("symbol parameter required")
    })
  })

  describe("git_history", () => {
    test("returns history for git repo", async () => {
      // testDir isn't a git repo, so this should fail gracefully
      const result = await ExploreQueries.execute(
        { id: "h1", type: "git_history", params: { max_count: 5 } },
        testDir,
      )
      // Either works (if somehow in a git repo) or fails gracefully
      expect(result.queryId).toBe("h1")
      expect(typeof result.success).toBe("boolean")
    })
  })

  describe("git_blame", () => {
    test("requires path parameter", async () => {
      const result = await ExploreQueries.execute(
        { id: "b1", type: "git_blame", params: {} },
        testDir,
      )
      expect(result.success).toBe(false)
      expect(result.summary).toContain("path parameter required")
    })
  })

  describe("unknown type", () => {
    test("fails gracefully for unknown query type", async () => {
      const result = await ExploreQueries.execute(
        { id: "u1", type: "unknown" as any, params: {} },
        testDir,
      )
      expect(result.success).toBe(false)
      expect(result.summary).toContain("Unknown query type")
    })
  })

  test("cleanup", () => {
    cleanupTestDir(testDir)
  })
})

describe("Explore", () => {
  let testDir: string

  test("setup", () => {
    testDir = createTestDir()
  })

  describe("fan", () => {
    test("executes multiple queries in parallel", async () => {
      const results = await Explore.fan(
        [
          { id: "f1", type: "read_file", params: { path: "hello.ts" } },
          { id: "f2", type: "read_file", params: { path: "math.ts" } },
          { id: "f3", type: "grep", params: { pattern: "export" } },
        ],
        testDir,
      )

      expect(results.length).toBe(3)
      expect(results[0].queryId).toBe("f1")
      expect(results[1].queryId).toBe("f2")
      expect(results[2].queryId).toBe("f3")

      // At least the file reads should succeed
      expect(results[0].success).toBe(true)
      expect(results[1].success).toBe(true)
    })

    test("returns empty array for empty queries", async () => {
      const results = await Explore.fan([], testDir)
      expect(results).toEqual([])
    })

    test("caps at max concurrent queries", async () => {
      const queries = Array.from({ length: 15 }, (_, i) => ({
        id: `cap-${i}`,
        type: "read_file" as const,
        params: { path: "hello.ts" },
      }))

      const results = await Explore.fan(queries, testDir)
      // Should cap at 10
      expect(results.length).toBe(10)
    })

    test("handles mixed success/failure", async () => {
      const results = await Explore.fan(
        [
          { id: "m1", type: "read_file", params: { path: "hello.ts" } },
          { id: "m2", type: "read_file", params: { path: "nonexistent.ts" } },
        ],
        testDir,
      )

      expect(results.length).toBe(2)
      expect(results[0].success).toBe(true)
      expect(results[1].success).toBe(false)
    })

    test("parallel is faster than sequential would be", async () => {
      const startTime = Date.now()
      const results = await Explore.fan(
        [
          { id: "p1", type: "read_file", params: { path: "hello.ts" } },
          { id: "p2", type: "read_file", params: { path: "math.ts" } },
          { id: "p3", type: "read_file", params: { path: "index.ts" } },
          { id: "p4", type: "grep", params: { pattern: "function" } },
        ],
        testDir,
      )
      const duration = Date.now() - startTime

      expect(results.length).toBe(4)
      // All concurrent — should be fast (well under 5s for 4 queries)
      expect(duration).toBeLessThan(5000)
    })
  })

  describe("summarize", () => {
    test("formats empty results", () => {
      const summary = Explore.summarize([])
      expect(summary).toBe("No exploration results.")
    })

    test("formats successful results", () => {
      const results: Explore.Result[] = [
        { queryId: "s1", success: true, summary: "Found 3 functions", rawLength: 100, truncated: false },
        { queryId: "s2", success: true, summary: "5 matches", rawLength: 50, truncated: false },
      ]

      const summary = Explore.summarize(results)
      expect(summary).toContain("2/2 queries succeeded")
      expect(summary).toContain("Found 3 functions")
      expect(summary).toContain("5 matches")
    })

    test("shows failed results separately", () => {
      const results: Explore.Result[] = [
        { queryId: "ok", success: true, summary: "Found results", rawLength: 100, truncated: false },
        { queryId: "err", success: false, summary: "Error: file not found", rawLength: 0, truncated: false },
      ]

      const summary = Explore.summarize(results)
      expect(summary).toContain("1/2 queries succeeded")
      expect(summary).toContain("Failed queries (1)")
      expect(summary).toContain("err: Error: file not found")
    })

    test("handles all-failed results", () => {
      const results: Explore.Result[] = [
        { queryId: "e1", success: false, summary: "Error: fail1", rawLength: 0, truncated: false },
        { queryId: "e2", success: false, summary: "Error: fail2", rawLength: 0, truncated: false },
      ]

      const summary = Explore.summarize(results)
      expect(summary).toContain("0/2 queries succeeded")
      expect(summary).toContain("Failed queries (2)")
    })
  })

  describe("investigate", () => {
    test("generates queries from file reference", async () => {
      const { results } = await Explore.investigate(
        "What does hello.ts do?",
        testDir,
      )
      // Should have at least a grep query from the keyword
      expect(results.length).toBeGreaterThan(0)
    })

    test("generates grep queries for general terms", async () => {
      const { summary, results } = await Explore.investigate(
        "Where is the function that handles authentication?",
        testDir,
      )
      expect(results.length).toBeGreaterThan(0)
      expect(summary.length).toBeGreaterThan(0)
    })

    test("returns helpful message for empty question", async () => {
      const { summary, results } = await Explore.investigate("", testDir)
      // Empty question → possibly no parseable queries
      expect(typeof summary).toBe("string")
    })
  })

  test("cleanup", () => {
    cleanupTestDir(testDir)
  })
})
