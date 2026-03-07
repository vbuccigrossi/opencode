import { Log } from "../util/log"
import { spawn } from "child_process"
import path from "path"
import fs from "fs/promises"

/**
 * Structured git operations.
 *
 * Provides typed, safe git operations with structured output.
 * No force operations — the agent must use bash explicitly for those.
 */
export namespace Git {
  const log = Log.create({ service: "git" })

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted"

  export interface StatusEntry {
    file: string
    status: FileStatus
    staged: boolean
    /** For renames: the original path. */
    originalFile?: string
  }

  export interface StatusResult {
    entries: StatusEntry[]
    branch: string
    ahead: number
    behind: number
    hasConflicts: boolean
  }

  export interface BranchInfo {
    name: string
    current: boolean
    tracking?: string
    ahead: number
    behind: number
    lastCommit: string
    lastCommitDate: string
  }

  export interface StashEntry {
    index: number
    message: string
    branch: string
    date: string
  }

  export interface CommitResult {
    hash: string
    message: string
    filesChanged: number
  }

  export interface MergeResult {
    success: boolean
    message: string
    conflicts: string[]
  }

  export type WorkflowType = "trunk-based" | "git-flow" | "github-flow" | "unknown"

  // ---------------------------------------------------------------------------
  // Git runner
  // ---------------------------------------------------------------------------

  function run(args: string[], cwd: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => {
        proc.kill("SIGTERM")
        resolve({ stdout, stderr: stderr + `\nTimeout after ${timeoutMs}ms`, exitCode: -1 })
      }, timeoutMs)

      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString()
      })
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString()
      })
      proc.on("close", (code) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      })
      proc.on("error", (err) => {
        clearTimeout(timer)
        resolve({ stdout, stderr: err.message, exitCode: -1 })
      })
    })
  }

  async function git(args: string[], cwd: string, timeoutMs?: number): Promise<string> {
    const result = await run(args, cwd, timeoutMs)
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.substring(0, 300)}`)
    }
    return result.stdout
  }

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  /**
   * Structured git status.
   */
  export async function status(cwd: string): Promise<StatusResult> {
    const output = await git(["status", "--porcelain=v2", "--branch"], cwd)
    const lines = output.split("\n")
    const entries: StatusEntry[] = []
    let branch = ""
    let ahead = 0
    let behind = 0

    for (const line of lines) {
      if (line.startsWith("# branch.head ")) {
        branch = line.substring(14)
      } else if (line.startsWith("# branch.ab ")) {
        const match = line.match(/\+(\d+)\s+-(\d+)/)
        if (match) {
          ahead = parseInt(match[1])
          behind = parseInt(match[2])
        }
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        const entry = parseStatusEntry(line)
        if (entry) entries.push(entry)
      } else if (line.startsWith("u ")) {
        // Unmerged entries (conflicts)
        const parts = line.split("\t")
        const file = parts[parts.length - 1] ?? line.split(" ").pop() ?? ""
        entries.push({ file: file.trim(), status: "conflicted", staged: false })
      } else if (line.startsWith("? ")) {
        const file = line.substring(2)
        entries.push({ file, status: "untracked", staged: false })
      }
    }

    return {
      entries,
      branch,
      ahead,
      behind,
      hasConflicts: entries.some((e) => e.status === "conflicted"),
    }
  }

  function parseStatusEntry(line: string): StatusEntry | null {
    // Porcelain v2 format: "1 XY sub mH mI mW hH hI path" or "2 XY sub ... path\torigPath"
    const parts = line.split("\t")
    const mainParts = (parts[0] ?? "").split(" ")
    const xy = mainParts[1] ?? ""
    const isRenamed = line.startsWith("2 ")
    const file = isRenamed ? (parts[1] ?? mainParts[mainParts.length - 1] ?? "") : (mainParts[mainParts.length - 1] ?? "")

    const indexStatus = xy[0] ?? "."
    const workStatus = xy[1] ?? "."

    let status: FileStatus = "modified"
    let staged = false

    if (indexStatus === "A") {
      status = "added"
      staged = true
    } else if (indexStatus === "D" || workStatus === "D") {
      status = "deleted"
      staged = indexStatus === "D"
    } else if (indexStatus === "R" || isRenamed) {
      status = "renamed"
      staged = true
    } else if (indexStatus === "M") {
      status = "modified"
      staged = true
    } else if (workStatus === "M") {
      status = "modified"
      staged = false
    }

    return {
      file: file.trim(),
      status,
      staged,
      originalFile: isRenamed ? parts[0]?.split(" ").pop() : undefined,
    }
  }

  /**
   * Create a new branch.
   */
  export async function branchCreate(cwd: string, name: string, checkout = true, startPoint?: string): Promise<string> {
    const args = checkout ? ["checkout", "-b", name] : ["branch", name]
    if (startPoint) args.push(startPoint)
    await git(args, cwd)
    return name
  }

  /**
   * List branches with metadata.
   */
  export async function branchList(cwd: string): Promise<BranchInfo[]> {
    const output = await git(
      ["branch", "-vv", "--format=%(HEAD)%(refname:short)\t%(upstream:short)\t%(upstream:track,nobracket)\t%(objectname:short)\t%(creatordate:iso)"],
      cwd,
    )
    const branches: BranchInfo[] = []

    for (const line of output.split("\n").filter(Boolean)) {
      const current = line.startsWith("*")
      const parts = line.substring(1).split("\t")
      const name = parts[0] ?? ""
      const tracking = parts[1] || undefined
      const trackInfo = parts[2] ?? ""
      const hash = parts[3] ?? ""
      const date = parts[4] ?? ""

      const aheadMatch = trackInfo.match(/ahead (\d+)/)
      const behindMatch = trackInfo.match(/behind (\d+)/)

      branches.push({
        name,
        current,
        tracking,
        ahead: aheadMatch ? parseInt(aheadMatch[1]) : 0,
        behind: behindMatch ? parseInt(behindMatch[1]) : 0,
        lastCommit: hash,
        lastCommitDate: date,
      })
    }

    return branches
  }

  /**
   * Stage files and commit.
   *
   * Refuses to commit files that look like they contain secrets.
   */
  export async function commit(
    cwd: string,
    message: string,
    files: string[],
  ): Promise<CommitResult> {
    // Safety: refuse to commit obvious secret files
    const DANGEROUS_PATTERNS = [/\.env$/, /\.env\.local$/, /credentials/, /\.pem$/, /\.key$/, /id_rsa/, /id_ed25519/]
    const blocked = files.filter((f) => DANGEROUS_PATTERNS.some((p) => p.test(f)))
    if (blocked.length > 0) {
      throw new Error(`Refusing to commit potentially sensitive files: ${blocked.join(", ")}. Use git directly if intentional.`)
    }

    // Stage files
    for (const file of files) {
      await git(["add", "--", file], cwd)
    }

    // Commit
    await git(["commit", "-m", message], cwd)

    // Get commit info
    const hash = (await git(["rev-parse", "--short", "HEAD"], cwd)).trim()
    const diffStat = await git(["diff", "--stat", "HEAD~1..HEAD"], cwd)
    const filesChanged = (diffStat.match(/(\d+) files? changed/) ?? [])[1] ?? "0"

    return {
      hash,
      message,
      filesChanged: parseInt(filesChanged),
    }
  }

  /**
   * Stash operations.
   */
  export async function stashSave(cwd: string, message?: string): Promise<string> {
    const args = ["stash", "push"]
    if (message) args.push("-m", message)
    return (await git(args, cwd)).trim()
  }

  export async function stashPop(cwd: string, index = 0): Promise<string> {
    return (await git(["stash", "pop", `stash@{${index}}`], cwd)).trim()
  }

  export async function stashList(cwd: string): Promise<StashEntry[]> {
    const { stdout } = await run(["stash", "list", "--format=%gd\t%gs\t%ci"], cwd)
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t")
        const indexMatch = (parts[0] ?? "").match(/\{(\d+)\}/)
        return {
          index: indexMatch ? parseInt(indexMatch[1]) : 0,
          message: parts[1] ?? "",
          branch: "",
          date: parts[2] ?? "",
        }
      })
  }

  export async function stashDrop(cwd: string, index = 0): Promise<string> {
    return (await git(["stash", "drop", `stash@{${index}}`], cwd)).trim()
  }

  /**
   * Cherry-pick a commit with conflict detection.
   */
  export async function cherryPick(cwd: string, commitHash: string): Promise<MergeResult> {
    const result = await run(["cherry-pick", commitHash], cwd)
    if (result.exitCode === 0) {
      return { success: true, message: `Cherry-picked ${commitHash}`, conflicts: [] }
    }

    // Check for conflicts
    const conflicts = await getConflictFiles(cwd)
    if (conflicts.length > 0) {
      return { success: false, message: `Cherry-pick of ${commitHash} resulted in conflicts`, conflicts }
    }

    throw new Error(`Cherry-pick failed: ${result.stderr.substring(0, 300)}`)
  }

  /**
   * Merge a branch with conflict detection.
   */
  export async function merge(cwd: string, branch: string): Promise<MergeResult> {
    const result = await run(["merge", "--no-edit", branch], cwd)
    if (result.exitCode === 0) {
      return { success: true, message: `Merged ${branch}`, conflicts: [] }
    }

    const conflicts = await getConflictFiles(cwd)
    if (conflicts.length > 0) {
      return { success: false, message: `Merge of ${branch} resulted in conflicts`, conflicts }
    }

    throw new Error(`Merge failed: ${result.stderr.substring(0, 300)}`)
  }

  /**
   * Get files with merge conflicts.
   */
  export async function getConflictFiles(cwd: string): Promise<string[]> {
    const { stdout } = await run(["diff", "--name-only", "--diff-filter=U"], cwd)
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  }

  /**
   * Detect branching workflow from git history.
   */
  export async function detectWorkflow(cwd: string): Promise<WorkflowType> {
    const { stdout } = await run(["branch", "-a"], cwd)
    const branches = stdout
      .split("\n")
      .map((b) => b.trim().replace(/^\*\s*/, ""))
      .filter(Boolean)

    // Git-flow indicators
    const hasFeature = branches.some((b) => b.startsWith("feature/") || b.includes("/feature/"))
    const hasDevelop = branches.some((b) => b === "develop" || b.endsWith("/develop"))
    const hasRelease = branches.some((b) => b.startsWith("release/") || b.includes("/release/"))
    if (hasDevelop && (hasFeature || hasRelease)) return "git-flow"

    // GitHub-flow: branches off main, PRs
    const hasMain = branches.some((b) => b === "main" || b === "master" || b.endsWith("/main") || b.endsWith("/master"))
    const featureBranches = branches.filter(
      (b) =>
        !b.includes("HEAD") &&
        b !== "main" &&
        b !== "master" &&
        !b.endsWith("/main") &&
        !b.endsWith("/master") &&
        !b.startsWith("remotes/"),
    )
    if (hasMain && featureBranches.length > 0) return "github-flow"

    // Trunk-based: mostly main, few short-lived branches
    if (hasMain && featureBranches.length <= 1) return "trunk-based"

    return "unknown"
  }

  /**
   * Suggest a branch name following project conventions.
   */
  export async function suggestBranch(cwd: string, description: string): Promise<string> {
    const workflow = await detectWorkflow(cwd)
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50)

    switch (workflow) {
      case "git-flow":
        return `feature/${slug}`
      case "github-flow":
      case "trunk-based":
      default:
        return slug
    }
  }

  /**
   * List branches that are merged but not deleted.
   */
  export async function staleBranches(cwd: string): Promise<string[]> {
    const { stdout } = await run(["branch", "--merged", "HEAD"], cwd)
    return stdout
      .split("\n")
      .map((b) => b.trim().replace(/^\*\s*/, ""))
      .filter((b) => b && b !== "main" && b !== "master" && b !== "develop" && b !== "dev")
  }

  /**
   * Get short log of recent commits.
   */
  export async function shortLog(cwd: string, count = 10): Promise<string> {
    return (await git(["log", "--oneline", `-n${count}`], cwd)).trim()
  }

  /**
   * Get current branch name.
   */
  export async function currentBranch(cwd: string): Promise<string> {
    return (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim()
  }

  /**
   * Check if a ref exists.
   */
  export async function refExists(cwd: string, ref: string): Promise<boolean> {
    const result = await run(["rev-parse", "--verify", ref], cwd)
    return result.exitCode === 0
  }
}
