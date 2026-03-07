import z from "zod"
import path from "path"
import { $ } from "bun"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Snapshot } from "../snapshot"
import { Changelog } from "../session/changelog"
import { Log } from "../util/log"

/**
 * Diff tool — gives the agent structured access to file and project diffs.
 *
 * Supports working tree diffs, file-specific diffs, range diffs between refs,
 * session-scoped diffs via Snapshot, and hunk extraction for surgical review.
 */
export const DiffTool = Tool.define("diff", async () => ({
  description: `Inspect file and project diffs with structured output. Returns parsed hunks with line numbers for precise understanding of changes.

Operations:
- working: Show all uncommitted changes (staged + unstaged) as structured diffs
- file: Show diff for a specific file (working tree vs HEAD, or between two refs)
- range: Show diff between two git refs (commits, branches, tags)
- session: Show all changes made in the current session (snapshot-based)
- changelog: Show the change history log for the current session
- summary: Quick summary of changes (file count, additions, deletions)

Use this tool to review changes before committing, understand what the session has modified, or inspect specific file diffs with hunk-level detail.`,
  parameters: z.object({
    operation: z
      .enum(["working", "file", "range", "session", "changelog", "summary"])
      .describe("The diff operation to perform"),
    file: z.string().optional().describe("File path (required for file operation, relative to project root)"),
    ref1: z.string().optional().describe("First git ref (for range operation, or base ref for file operation)"),
    ref2: z.string().optional().describe("Second git ref (for range operation)"),
    hunk_index: z.number().optional().describe("Extract a specific hunk by index (0-based, for file operation)"),
  }),
  async execute(params): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "working":
        return await diffWorking()
      case "file":
        return await diffFile(params.file, params.ref1, params.ref2, params.hunk_index)
      case "range":
        return await diffRange(params.ref1, params.ref2)
      case "session":
        return await diffSession()
      case "changelog":
        return changelogEntries()
      case "summary":
        return diffSummary()
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

/** Show all uncommitted changes. */
async function diffWorking(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const cwd = Instance.directory
  // Get both staged and unstaged diff
  const result = await $`git -c core.quotepath=false diff --no-ext-diff HEAD`
    .cwd(cwd).quiet().nothrow().text()

  if (!result.trim()) {
    // Check for untracked files
    const untracked = await $`git -c core.quotepath=false ls-files --others --exclude-standard`
      .cwd(cwd).quiet().nothrow().text()
    if (!untracked.trim()) {
      return {
        title: "diff: working",
        metadata: { files: 0, additions: 0, deletions: 0 },
        output: "No uncommitted changes.",
      }
    }
    return {
      title: "diff: working",
      metadata: { files: untracked.trim().split("\n").length, untracked: true },
      output: `Untracked files:\n${untracked.trim().split("\n").map((f) => `  + ${f}`).join("\n")}`,
    }
  }

  const stats = parseDiffStats(result)
  return {
    title: "diff: working",
    metadata: stats,
    output: result.trim(),
  }
}

/** Show diff for a specific file. */
async function diffFile(
  file?: string,
  ref1?: string,
  ref2?: string,
  hunkIndex?: number,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!file) throw new Error("file parameter is required for file operation")
  const cwd = Instance.directory

  let diffCmd: string[]
  if (ref1 && ref2) {
    diffCmd = ["git", "-c", "core.quotepath=false", "diff", "--no-ext-diff", ref1, ref2, "--", file]
  } else if (ref1) {
    diffCmd = ["git", "-c", "core.quotepath=false", "diff", "--no-ext-diff", ref1, "--", file]
  } else {
    diffCmd = ["git", "-c", "core.quotepath=false", "diff", "--no-ext-diff", "HEAD", "--", file]
  }

  const result = await $`${diffCmd}`.cwd(cwd).quiet().nothrow().text()

  if (!result.trim()) {
    return {
      title: `diff: ${file}`,
      metadata: { files: 0, additions: 0, deletions: 0 },
      output: `No changes in ${file}`,
    }
  }

  // If hunk_index specified, extract that specific hunk
  if (hunkIndex !== undefined) {
    const hunks = parseHunks(result)
    if (hunkIndex < 0 || hunkIndex >= hunks.length) {
      throw new Error(`Hunk index ${hunkIndex} out of range (0-${hunks.length - 1})`)
    }
    const hunk = hunks[hunkIndex]
    return {
      title: `diff: ${file} hunk ${hunkIndex}`,
      metadata: { hunkIndex, totalHunks: hunks.length, ...hunk.stats },
      output: hunk.content,
    }
  }

  const stats = parseDiffStats(result)
  return {
    title: `diff: ${file}`,
    metadata: stats,
    output: result.trim(),
  }
}

/** Show diff between two git refs. */
async function diffRange(
  ref1?: string,
  ref2?: string,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!ref1) throw new Error("ref1 parameter is required for range operation")
  const cwd = Instance.directory
  const ref2Actual = ref2 ?? "HEAD"

  const result = await $`git -c core.quotepath=false diff --no-ext-diff --stat ${ref1} ${ref2Actual}`
    .cwd(cwd).quiet().nothrow().text()
  const fullDiff = await $`git -c core.quotepath=false diff --no-ext-diff ${ref1} ${ref2Actual}`
    .cwd(cwd).quiet().nothrow().text()

  if (!fullDiff.trim()) {
    return {
      title: `diff: ${ref1}..${ref2Actual}`,
      metadata: { files: 0, additions: 0, deletions: 0 },
      output: `No differences between ${ref1} and ${ref2Actual}`,
    }
  }

  const stats = parseDiffStats(fullDiff)
  return {
    title: `diff: ${ref1}..${ref2Actual}`,
    metadata: stats,
    output: `${result.trim()}\n\n${fullDiff.trim()}`,
  }
}

/** Show all changes made in the current session via Snapshot. */
async function diffSession(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const affected = Changelog.affectedFiles()
  if (affected.length === 0) {
    return {
      title: "diff: session",
      metadata: { files: 0, additions: 0, deletions: 0 },
      output: "No changes recorded in this session.",
    }
  }

  // Use git diff HEAD for session-changed files
  const cwd = Instance.directory
  const relativePaths = affected.map((f) => path.relative(cwd, f)).filter(Boolean)

  if (relativePaths.length === 0) {
    return {
      title: "diff: session",
      metadata: { files: 0 },
      output: "No changes in session-tracked files.",
    }
  }

  const result = await $`git -c core.quotepath=false diff --no-ext-diff HEAD -- ${relativePaths}`
    .cwd(cwd).quiet().nothrow().text()

  const stats = parseDiffStats(result)
  const summary = Changelog.summarize()

  return {
    title: "diff: session",
    metadata: { ...stats, changelog: summary },
    output: result.trim() || "Session files have no uncommitted diff against HEAD.",
  }
}

/** Show the changelog entries for the current session. */
function changelogEntries(): { title: string; metadata: Record<string, any>; output: string } {
  const all = Changelog.all()
  if (all.length === 0) {
    return {
      title: "diff: changelog",
      metadata: { count: 0 },
      output: "No changes recorded in this session.",
    }
  }

  const lines = all.map((e) => {
    const rel = path.relative(Instance.directory, e.file)
    const time = new Date(e.timestamp).toLocaleTimeString()
    const stats = e.additions || e.deletions ? ` (+${e.additions}/-${e.deletions})` : ""
    const tool = e.toolID ? ` via ${e.toolID}` : ""
    return `#${e.id} [${time}] ${e.operation} ${rel}${stats}${tool}${e.summary ? ` — ${e.summary}` : ""}`
  })

  return {
    title: "diff: changelog",
    metadata: { count: all.length },
    output: `${all.length} change(s) this session:\n\n${lines.join("\n")}`,
  }
}

/** Quick summary of changes. */
function diffSummary(): { title: string; metadata: Record<string, any>; output: string } {
  const summary = Changelog.summarize()
  if (summary.files === 0) {
    return {
      title: "diff: summary",
      metadata: summary,
      output: "No changes recorded in this session.",
    }
  }
  const ops = Object.entries(summary.operations)
    .map(([op, count]) => `${count} ${op}(s)`)
    .join(", ")
  return {
    title: "diff: summary",
    metadata: summary,
    output: `Session changes: ${summary.files} file(s), +${summary.additions}/-${summary.deletions} lines. Operations: ${ops}`,
  }
}

// ---------------------------------------------------------------------------
// Diff parsing helpers
// ---------------------------------------------------------------------------

/** Parse basic stats from a unified diff string. */
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

/** Parse hunks from a unified diff. */
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
