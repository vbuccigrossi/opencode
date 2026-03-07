import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Git } from "../git"
import { Conflicts } from "../git/conflicts"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

/**
 * Git tool — structured git operations with safe defaults.
 *
 * Provides typed, structured git operations. No force operations —
 * those must go through bash explicitly.
 */
export const GitTool = Tool.define("git", async () => ({
  description: `Perform structured git operations with safe defaults and structured output.

Operations:
- status: Show working tree status (modified, staged, untracked, conflicts) with branch info
- branch_create: Create a new branch (optionally from a start point)
- branch_list: List branches with ahead/behind counts and tracking info
- commit: Stage specific files and commit (refuses to commit .env, credentials, keys)
- stash_save: Save working changes to stash with optional message
- stash_pop: Pop a stash entry (default: most recent)
- stash_list: List all stash entries
- cherry_pick: Cherry-pick a commit with conflict detection
- merge: Merge a branch with conflict detection
- conflicts: Parse and display merge conflicts with resolution suggestions
- resolve_conflict: Resolve a specific conflict hunk in a file
- suggest_branch: Suggest a branch name following project conventions
- stale_branches: List merged branches that can be cleaned up
- workflow: Detect the project's branching strategy (trunk-based, git-flow, github-flow)

Safety: commit refuses .env/credentials/key files. No force-push. Destructive operations require confirmation.`,
  parameters: z.object({
    operation: z
      .enum([
        "status",
        "branch_create",
        "branch_list",
        "commit",
        "stash_save",
        "stash_pop",
        "stash_list",
        "cherry_pick",
        "merge",
        "conflicts",
        "resolve_conflict",
        "suggest_branch",
        "stale_branches",
        "workflow",
      ])
      .describe("The git operation to perform"),
    branch: z.string().optional().describe("Branch name (for branch_create, merge)"),
    start_point: z.string().optional().describe("Starting ref for branch_create"),
    files: z.array(z.string()).optional().describe("Files to stage (for commit)"),
    message: z.string().optional().describe("Commit/stash message"),
    commit_hash: z.string().optional().describe("Commit hash (for cherry_pick)"),
    file: z.string().optional().describe("File path (for conflicts, resolve_conflict)"),
    hunk_index: z.number().optional().describe("0-based conflict hunk index (for resolve_conflict)"),
    strategy: z
      .enum(["ours", "theirs", "both", "custom"])
      .optional()
      .describe("Resolution strategy (for resolve_conflict)"),
    content: z.string().optional().describe("Custom content (for resolve_conflict with strategy=custom)"),
    description: z.string().optional().describe("Task description (for suggest_branch)"),
    stash_index: z.number().optional().describe("Stash index (for stash_pop, default: 0)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    const cwd = Instance.directory

    switch (params.operation) {
      case "status":
        return gitStatus(cwd)
      case "branch_create":
        return gitBranchCreate(cwd, params)
      case "branch_list":
        return gitBranchList(cwd)
      case "commit":
        return gitCommit(cwd, params, ctx)
      case "stash_save":
        return gitStashSave(cwd, params)
      case "stash_pop":
        return gitStashPop(cwd, params)
      case "stash_list":
        return gitStashList(cwd)
      case "cherry_pick":
        return gitCherryPick(cwd, params, ctx)
      case "merge":
        return gitMerge(cwd, params, ctx)
      case "conflicts":
        return gitConflicts(cwd, params)
      case "resolve_conflict":
        return gitResolveConflict(cwd, params)
      case "suggest_branch":
        return gitSuggestBranch(cwd, params)
      case "stale_branches":
        return gitStaleBranches(cwd)
      case "workflow":
        return gitWorkflow(cwd)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.git" })

async function gitStatus(cwd: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const s = await Git.status(cwd)
  const lines: string[] = [`Branch: ${s.branch}`]
  if (s.ahead > 0 || s.behind > 0) {
    lines.push(`  Ahead: ${s.ahead}, Behind: ${s.behind}`)
  }
  if (s.hasConflicts) {
    lines.push("  ⚠ Has merge conflicts")
  }
  lines.push("")

  if (s.entries.length === 0) {
    lines.push("Working tree clean.")
  } else {
    const staged = s.entries.filter((e) => e.staged)
    const unstaged = s.entries.filter((e) => !e.staged && e.status !== "untracked")
    const untracked = s.entries.filter((e) => e.status === "untracked")
    const conflicts = s.entries.filter((e) => e.status === "conflicted")

    if (conflicts.length > 0) {
      lines.push(`Conflicts (${conflicts.length}):`)
      for (const e of conflicts) lines.push(`  C  ${e.file}`)
      lines.push("")
    }
    if (staged.length > 0) {
      lines.push(`Staged (${staged.length}):`)
      for (const e of staged) lines.push(`  ${e.status[0].toUpperCase()}  ${e.file}`)
      lines.push("")
    }
    if (unstaged.length > 0) {
      lines.push(`Unstaged (${unstaged.length}):`)
      for (const e of unstaged) lines.push(`  ${e.status[0].toUpperCase()}  ${e.file}`)
      lines.push("")
    }
    if (untracked.length > 0) {
      lines.push(`Untracked (${untracked.length}):`)
      for (const e of untracked) lines.push(`  ?  ${e.file}`)
    }
  }

  return {
    title: `git: status (${s.entries.length} entries)`,
    metadata: { branch: s.branch, ahead: s.ahead, behind: s.behind, entries: s.entries.length, hasConflicts: s.hasConflicts },
    output: lines.join("\n"),
  }
}

async function gitBranchCreate(
  cwd: string,
  params: { branch?: string; start_point?: string },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.branch) throw new Error("branch parameter is required")
  const name = await Git.branchCreate(cwd, params.branch, true, params.start_point)
  return {
    title: `git: created branch ${name}`,
    metadata: { branch: name },
    output: `Created and switched to branch "${name}"${params.start_point ? ` from ${params.start_point}` : ""}.`,
  }
}

async function gitBranchList(cwd: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const branches = await Git.branchList(cwd)
  const lines = branches.map((b) => {
    const current = b.current ? "* " : "  "
    const tracking = b.tracking ? ` → ${b.tracking}` : ""
    const ahead = b.ahead > 0 ? ` +${b.ahead}` : ""
    const behind = b.behind > 0 ? ` -${b.behind}` : ""
    return `${current}${b.name}${tracking}${ahead}${behind} (${b.lastCommit})`
  })

  return {
    title: `git: ${branches.length} branch(es)`,
    metadata: { count: branches.length, current: branches.find((b) => b.current)?.name },
    output: lines.join("\n"),
  }
}

async function gitCommit(
  cwd: string,
  params: { files?: string[]; message?: string },
  ctx: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.files || params.files.length === 0) throw new Error("files parameter is required for commit")
  if (!params.message) throw new Error("message parameter is required for commit")

  await ctx.ask({ permission: "git", patterns: params.files, always: ["*"], metadata: { operation: "commit" } })

  const result = await Git.commit(cwd, params.message, params.files)
  return {
    title: `git: commit ${result.hash}`,
    metadata: { hash: result.hash, filesChanged: result.filesChanged },
    output: `Committed ${result.hash}: "${result.message}" (${result.filesChanged} files changed)`,
  }
}

async function gitStashSave(
  cwd: string,
  params: { message?: string },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const output = await Git.stashSave(cwd, params.message)
  return {
    title: "git: stash save",
    metadata: {},
    output: output || "Saved working directory state.",
  }
}

async function gitStashPop(
  cwd: string,
  params: { stash_index?: number },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const output = await Git.stashPop(cwd, params.stash_index ?? 0)
  return {
    title: "git: stash pop",
    metadata: { index: params.stash_index ?? 0 },
    output: output || "Applied stash and dropped it.",
  }
}

async function gitStashList(cwd: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const entries = await Git.stashList(cwd)
  if (entries.length === 0) {
    return { title: "git: stash list", metadata: { count: 0 }, output: "No stash entries." }
  }
  const lines = entries.map((e) => `stash@{${e.index}}: ${e.message} (${e.date})`)
  return {
    title: `git: ${entries.length} stash entries`,
    metadata: { count: entries.length },
    output: lines.join("\n"),
  }
}

async function gitCherryPick(
  cwd: string,
  params: { commit_hash?: string },
  ctx: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.commit_hash) throw new Error("commit_hash parameter is required")
  await ctx.ask({ permission: "git", patterns: [params.commit_hash], always: ["*"], metadata: { operation: "cherry_pick" } })

  const result = await Git.cherryPick(cwd, params.commit_hash)
  if (result.success) {
    return {
      title: `git: cherry-picked ${params.commit_hash}`,
      metadata: { success: true },
      output: result.message,
    }
  }

  return {
    title: `git: cherry-pick conflicts`,
    metadata: { success: false, conflicts: result.conflicts },
    output: `${result.message}\n\nConflicting files:\n${result.conflicts.map((f) => `  ${f}`).join("\n")}\n\nUse git conflicts operation to view and resolve.`,
  }
}

async function gitMerge(
  cwd: string,
  params: { branch?: string },
  ctx: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.branch) throw new Error("branch parameter is required")
  await ctx.ask({ permission: "git", patterns: [params.branch], always: ["*"], metadata: { operation: "merge" } })

  const result = await Git.merge(cwd, params.branch)
  if (result.success) {
    return {
      title: `git: merged ${params.branch}`,
      metadata: { success: true },
      output: result.message,
    }
  }

  return {
    title: `git: merge conflicts`,
    metadata: { success: false, conflicts: result.conflicts },
    output: `${result.message}\n\nConflicting files:\n${result.conflicts.map((f) => `  ${f}`).join("\n")}\n\nUse git conflicts operation to view and resolve.`,
  }
}

async function gitConflicts(
  cwd: string,
  params: { file?: string },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (params.file) {
    const filePath = path.resolve(cwd, params.file)
    const hunks = await Conflicts.parseFile(filePath)
    return {
      title: `git: ${hunks.length} conflict(s) in ${path.basename(filePath)}`,
      metadata: { file: filePath, conflicts: hunks.length },
      output: Conflicts.format(hunks),
    }
  }

  // Show all conflicted files
  const conflictFiles = await Git.getConflictFiles(cwd)
  if (conflictFiles.length === 0) {
    return { title: "git: no conflicts", metadata: { count: 0 }, output: "No merge conflicts found." }
  }

  const lines: string[] = [`${conflictFiles.length} file(s) with conflicts:`, ""]
  for (const file of conflictFiles) {
    const hunks = await Conflicts.parseFile(path.resolve(cwd, file))
    lines.push(`${file}: ${hunks.length} conflict(s)`)
  }
  lines.push("", "Use file parameter to view conflict details for a specific file.")

  return {
    title: `git: ${conflictFiles.length} conflicted file(s)`,
    metadata: { count: conflictFiles.length, files: conflictFiles },
    output: lines.join("\n"),
  }
}

async function gitResolveConflict(
  cwd: string,
  params: { file?: string; hunk_index?: number; strategy?: string; content?: string },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.file) throw new Error("file parameter is required")
  if (params.hunk_index === undefined) throw new Error("hunk_index parameter is required (0-based)")
  if (!params.strategy) throw new Error("strategy parameter is required")

  const filePath = path.resolve(cwd, params.file)
  await Conflicts.resolveFile(filePath, [
    {
      hunkIndex: params.hunk_index,
      strategy: params.strategy as Conflicts.Strategy,
      content: params.content,
    },
  ])

  // Check remaining conflicts
  const remaining = await Conflicts.parseFile(filePath)

  return {
    title: `git: resolved conflict #${params.hunk_index} in ${path.basename(filePath)}`,
    metadata: { file: filePath, remaining: remaining.length },
    output: `Resolved conflict #${params.hunk_index} using "${params.strategy}" strategy.${remaining.length > 0 ? ` ${remaining.length} conflict(s) remaining.` : " All conflicts resolved in this file."}`,
  }
}

async function gitSuggestBranch(
  cwd: string,
  params: { description?: string },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.description) throw new Error("description parameter is required")
  const name = await Git.suggestBranch(cwd, params.description)
  const workflow = await Git.detectWorkflow(cwd)

  return {
    title: "git: suggest branch",
    metadata: { name, workflow },
    output: `Suggested branch name: "${name}" (project uses ${workflow} workflow)`,
  }
}

async function gitStaleBranches(cwd: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const stale = await Git.staleBranches(cwd)
  if (stale.length === 0) {
    return { title: "git: no stale branches", metadata: { count: 0 }, output: "No stale branches found." }
  }

  return {
    title: `git: ${stale.length} stale branch(es)`,
    metadata: { count: stale.length, branches: stale },
    output: `${stale.length} merged branch(es) that can be cleaned up:\n\n${stale.map((b) => `  ${b}`).join("\n")}`,
  }
}

async function gitWorkflow(cwd: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const workflow = await Git.detectWorkflow(cwd)
  const descriptions: Record<Git.WorkflowType, string> = {
    "trunk-based": "Trunk-based development: commits directly to main, short-lived branches",
    "git-flow": "Git-flow: develop/release/feature/hotfix branching model",
    "github-flow": "GitHub-flow: feature branches off main with pull requests",
    unknown: "Unable to determine branching strategy from history",
  }

  return {
    title: `git: ${workflow} workflow`,
    metadata: { workflow },
    output: descriptions[workflow],
  }
}
