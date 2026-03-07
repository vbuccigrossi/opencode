import { describe, expect, test } from "bun:test"
import { GitHistory } from "../../src/search/git-history"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { execSync } from "child_process"

/** Create a temporary git repo with some commits. */
async function setupGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-hist-test-"))
  execSync("git init", { cwd: dir, stdio: "ignore" })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "ignore" })
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "ignore" })

  // First commit
  await fs.writeFile(path.join(dir, "file.txt"), "hello world\n")
  execSync("git add .", { cwd: dir, stdio: "ignore" })
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: "ignore" })

  // Second commit
  await fs.writeFile(path.join(dir, "file.txt"), "hello world\nline two\n")
  execSync("git add .", { cwd: dir, stdio: "ignore" })
  execSync('git commit -m "add line two"', { cwd: dir, stdio: "ignore" })

  // Third commit
  await fs.writeFile(path.join(dir, "other.ts"), "function greet() { return 'hi' }\n")
  execSync("git add .", { cwd: dir, stdio: "ignore" })
  execSync('git commit -m "add greet function"', { cwd: dir, stdio: "ignore" })

  return dir
}

describe("git-history.logHistory", () => {
  test("returns structured commits", async () => {
    const dir = await setupGitRepo()
    try {
      const commits = await GitHistory.logHistory(dir)
      expect(commits.length).toBe(3)
      expect(commits[0].author).toBe("Test User")
      expect(commits[0].shortHash.length).toBeGreaterThan(0)
      expect(commits[0].date).toContain("T")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("respects maxCount", async () => {
    const dir = await setupGitRepo()
    try {
      const commits = await GitHistory.logHistory(dir, { maxCount: 2 })
      expect(commits.length).toBe(2)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("filters by file", async () => {
    const dir = await setupGitRepo()
    try {
      const commits = await GitHistory.logHistory(dir, { file: "other.ts" })
      expect(commits.length).toBe(1)
      expect(commits[0].message).toContain("greet")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git-history.search", () => {
  test("searches commit messages", async () => {
    const dir = await setupGitRepo()
    try {
      const commits = await GitHistory.search(dir, "greet")
      expect(commits.length).toBe(1)
      expect(commits[0].message).toContain("greet")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("returns empty for non-matching query", async () => {
    const dir = await setupGitRepo()
    try {
      const commits = await GitHistory.search(dir, "nonexistent_term_xyz")
      expect(commits.length).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git-history.blame", () => {
  test("returns structured blame", async () => {
    const dir = await setupGitRepo()
    try {
      const blame = await GitHistory.blame(dir, "file.txt")
      expect(blame.length).toBe(2) // Two lines in file.txt
      expect(blame[0].author).toBe("Test User")
      expect(blame[0].content).toBe("hello world")
      expect(blame[0].line).toBe(1)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("supports line range", async () => {
    const dir = await setupGitRepo()
    try {
      const blame = await GitHistory.blame(dir, "file.txt", [2, 2])
      expect(blame.length).toBe(1)
      expect(blame[0].content).toBe("line two")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git-history.pickaxe", () => {
  test("finds commits introducing text", async () => {
    const dir = await setupGitRepo()
    try {
      const commits = await GitHistory.pickaxe(dir, "greet")
      expect(commits.length).toBeGreaterThanOrEqual(1)
      expect(commits[0].message).toContain("greet")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git-history.commitRange", () => {
  test("returns commits between refs", async () => {
    const dir = await setupGitRepo()
    try {
      const all = await GitHistory.logHistory(dir)
      const oldest = all[all.length - 1].hash
      const newest = all[0].hash
      const range = await GitHistory.commitRange(dir, oldest, newest)
      // Should have commits between first and last (not including first)
      expect(range.length).toBe(2)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git-history.format", () => {
  test("formats empty results", () => {
    expect(GitHistory.format([])).toBe("No matching commits found.")
  })

  test("formats commits", () => {
    const commits: GitHistory.Commit[] = [
      { hash: "abc123def", shortHash: "abc123d", author: "Test", authorEmail: "t@t.com", date: "2026-03-07T00:00:00Z", message: "test commit" },
    ]
    const output = GitHistory.format(commits)
    expect(output).toContain("abc123d")
    expect(output).toContain("Test")
    expect(output).toContain("test commit")
  })
})
