import { describe, expect, test } from "bun:test"
import { DocSearch } from "../../src/search/docs"
import fs from "fs/promises"
import path from "path"
import os from "os"

async function setupDocDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-test-"))

  await fs.writeFile(
    path.join(dir, "README.md"),
    [
      "# My Project",
      "",
      "## Installation",
      "",
      "Run `npm install` to install dependencies.",
      "",
      "## Usage",
      "",
      "Import the `Authentication` module and call `authenticate()`.",
      "",
      "## API",
      "",
      "The `fetchData` function retrieves data from the server.",
    ].join("\n"),
  )

  await fs.mkdir(path.join(dir, "docs"))
  await fs.writeFile(
    path.join(dir, "docs", "api.md"),
    [
      "# API Reference",
      "",
      "## Authentication",
      "",
      "The Authentication module handles user login and session management.",
      "Use `authenticate(credentials)` to log in.",
      "",
      "## Data",
      "",
      "The fetchData function accepts a query parameter and returns results.",
    ].join("\n"),
  )

  await fs.writeFile(
    path.join(dir, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## v2.0.0",
      "",
      "- Rewrote Authentication to use JWT tokens",
      "- Added fetchData caching",
      "",
      "## v1.0.0",
      "",
      "- Initial release",
    ].join("\n"),
  )

  return dir
}

describe("docs.index", () => {
  test("indexes documentation files", async () => {
    const dir = await setupDocDir()
    try {
      const idx = await DocSearch.index(dir)
      expect(idx.files.length).toBeGreaterThanOrEqual(3) // README, docs/api.md, CHANGELOG
      expect(idx.files.some((f) => f.source === "readme")).toBe(true)
      expect(idx.files.some((f) => f.source === "docs")).toBe(true)
      expect(idx.files.some((f) => f.source === "changelog")).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("skips node_modules", async () => {
    const dir = await setupDocDir()
    try {
      await fs.mkdir(path.join(dir, "node_modules"))
      await fs.writeFile(path.join(dir, "node_modules", "README.md"), "# Package")
      const idx = await DocSearch.index(dir)
      expect(idx.files.every((f) => !f.path.includes("node_modules"))).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("docs.search", () => {
  test("finds relevant docs by query", async () => {
    const dir = await setupDocDir()
    try {
      const idx = await DocSearch.index(dir)
      const results = DocSearch.search(idx, "Authentication")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].snippet.toLowerCase()).toContain("authentication")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("ranks README higher than other docs", async () => {
    const dir = await setupDocDir()
    try {
      const idx = await DocSearch.index(dir)
      const results = DocSearch.search(idx, "install")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].source).toBe("readme")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("returns empty for non-matching query", async () => {
    const dir = await setupDocDir()
    try {
      const idx = await DocSearch.index(dir)
      const results = DocSearch.search(idx, "nonexistent_xyz_term")
      expect(results.length).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("docs.explain", () => {
  test("finds documentation for a symbol", async () => {
    const dir = await setupDocDir()
    try {
      const idx = await DocSearch.index(dir)
      const results = DocSearch.explain(idx, "Authentication")
      expect(results.length).toBeGreaterThan(0)
      // Should find it in README, docs, and changelog
      const sources = new Set(results.map((r) => r.source))
      expect(sources.size).toBeGreaterThanOrEqual(2)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("returns empty for unknown symbol", async () => {
    const dir = await setupDocDir()
    try {
      const idx = await DocSearch.index(dir)
      const results = DocSearch.explain(idx, "ZxYqNonExistent")
      expect(results.length).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("docs.format", () => {
  test("formats empty results", () => {
    expect(DocSearch.format([])).toBe("No documentation found.")
  })

  test("formats results with source and score", () => {
    const results: DocSearch.Result[] = [
      { file: "/app/README.md", line: 5, score: 3.14, snippet: "Install the package", source: "readme" },
    ]
    const output = DocSearch.format(results, "/app")
    expect(output).toContain("[readme]")
    expect(output).toContain("README.md:5")
    expect(output).toContain("3.14")
  })
})
