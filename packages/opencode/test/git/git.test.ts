import { describe, expect, test } from "bun:test"
import { Git } from "../../src/git"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { execSync } from "child_process"

async function setupGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-test-"))
  execSync("git init", { cwd: dir, stdio: "ignore" })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "ignore" })
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "ignore" })

  await fs.writeFile(path.join(dir, "file.txt"), "hello\n")
  execSync("git add .", { cwd: dir, stdio: "ignore" })
  execSync('git commit -m "initial"', { cwd: dir, stdio: "ignore" })
  return dir
}

describe("git.status", () => {
  test("returns clean status", async () => {
    const dir = await setupGitRepo()
    try {
      const s = await Git.status(dir)
      expect(s.entries.length).toBe(0)
      expect(s.branch).toBeTruthy()
      expect(s.hasConflicts).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("detects modified file", async () => {
    const dir = await setupGitRepo()
    try {
      await fs.writeFile(path.join(dir, "file.txt"), "modified\n")
      const s = await Git.status(dir)
      expect(s.entries.length).toBe(1)
      expect(s.entries[0].status).toBe("modified")
      expect(s.entries[0].file).toBe("file.txt")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("detects untracked file", async () => {
    const dir = await setupGitRepo()
    try {
      await fs.writeFile(path.join(dir, "new.txt"), "new file\n")
      const s = await Git.status(dir)
      expect(s.entries.some((e) => e.status === "untracked" && e.file === "new.txt")).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("detects staged file", async () => {
    const dir = await setupGitRepo()
    try {
      await fs.writeFile(path.join(dir, "file.txt"), "modified\n")
      execSync("git add file.txt", { cwd: dir, stdio: "ignore" })
      const s = await Git.status(dir)
      expect(s.entries.some((e) => e.staged && e.file === "file.txt")).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git.branchCreate", () => {
  test("creates and switches to new branch", async () => {
    const dir = await setupGitRepo()
    try {
      const name = await Git.branchCreate(dir, "feature-test")
      expect(name).toBe("feature-test")
      const current = await Git.currentBranch(dir)
      expect(current).toBe("feature-test")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git.branchList", () => {
  test("lists branches", async () => {
    const dir = await setupGitRepo()
    try {
      await Git.branchCreate(dir, "other-branch")
      execSync("git checkout -", { cwd: dir, stdio: "ignore" }) // back to main
      const branches = await Git.branchList(dir)
      expect(branches.length).toBeGreaterThanOrEqual(2)
      expect(branches.some((b) => b.name === "other-branch")).toBe(true)
      expect(branches.some((b) => b.current)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git.commit", () => {
  test("commits staged files", async () => {
    const dir = await setupGitRepo()
    try {
      await fs.writeFile(path.join(dir, "new.txt"), "content\n")
      const result = await Git.commit(dir, "add new file", ["new.txt"])
      expect(result.hash.length).toBeGreaterThan(0)
      expect(result.message).toBe("add new file")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("refuses to commit .env files", async () => {
    const dir = await setupGitRepo()
    try {
      await fs.writeFile(path.join(dir, ".env"), "SECRET=value\n")
      await expect(Git.commit(dir, "add env", [".env"])).rejects.toThrow("sensitive")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git.stash", () => {
  test("save and pop stash", async () => {
    const dir = await setupGitRepo()
    try {
      await fs.writeFile(path.join(dir, "file.txt"), "modified\n")
      await Git.stashSave(dir, "test stash")

      // File should be restored to original
      const content = await fs.readFile(path.join(dir, "file.txt"), "utf-8")
      expect(content).toBe("hello\n")

      // Pop should restore modification
      await Git.stashPop(dir)
      const restored = await fs.readFile(path.join(dir, "file.txt"), "utf-8")
      expect(restored).toBe("modified\n")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("stash list returns entries", async () => {
    const dir = await setupGitRepo()
    try {
      await fs.writeFile(path.join(dir, "file.txt"), "modified\n")
      await Git.stashSave(dir, "my stash")
      const entries = await Git.stashList(dir)
      expect(entries.length).toBe(1)
      expect(entries[0].message).toContain("my stash")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git.detectWorkflow", () => {
  test("detects trunk-based for simple repo", async () => {
    const dir = await setupGitRepo()
    try {
      const workflow = await Git.detectWorkflow(dir)
      // Simple repo with just one branch should be trunk-based or unknown
      expect(["trunk-based", "unknown"]).toContain(workflow)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git.suggestBranch", () => {
  test("generates slug from description", async () => {
    const dir = await setupGitRepo()
    try {
      const name = await Git.suggestBranch(dir, "Fix the login bug")
      expect(name).toContain("fix")
      expect(name).toContain("login")
      expect(name).not.toContain(" ")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git.staleBranches", () => {
  test("finds merged branches", async () => {
    const dir = await setupGitRepo()
    try {
      // Create and merge a branch
      await Git.branchCreate(dir, "to-merge")
      await fs.writeFile(path.join(dir, "merged.txt"), "merged content\n")
      execSync("git add . && git commit -m 'merge content'", { cwd: dir, stdio: "ignore" })
      execSync("git checkout -", { cwd: dir, stdio: "ignore" })
      execSync("git merge to-merge --no-edit", { cwd: dir, stdio: "ignore" })

      const stale = await Git.staleBranches(dir)
      expect(stale).toContain("to-merge")
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("git.refExists", () => {
  test("returns true for HEAD", async () => {
    const dir = await setupGitRepo()
    try {
      expect(await Git.refExists(dir, "HEAD")).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("returns false for nonexistent ref", async () => {
    const dir = await setupGitRepo()
    try {
      expect(await Git.refExists(dir, "nonexistent-ref-xyz")).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})
