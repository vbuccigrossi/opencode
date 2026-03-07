import z from "zod"
import path from "path"
import { $ } from "bun"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Snapshot } from "../snapshot"
import { Changelog } from "../session/changelog"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

/**
 * Undo tool — surgical undo of file changes using the Snapshot system.
 *
 * Supports file-level restore, last-edit undo, and preview of undo operations.
 * All undo operations create a snapshot before applying so they are themselves undoable.
 */
export const UndoTool = Tool.define("undo", async () => ({
  description: `Surgically undo file changes without reverting the entire session.

Operations:
- file: Restore a specific file to its state at HEAD or a given git ref
- last_edit: Undo the most recent edit to a specific file (restores the file to its state before the last recorded change)
- preview: Show what an undo operation would do without applying it
- list: Show all undoable edits in the current session

Use this tool when you need to revert a specific change without affecting other files. All undo operations are themselves undoable.`,
  parameters: z.object({
    operation: z
      .enum(["file", "last_edit", "preview", "list"])
      .describe("The undo operation to perform"),
    file: z.string().optional().describe("File path (required for file, last_edit, preview operations)"),
    ref: z.string().optional().describe("Git ref to restore from (for file operation, defaults to HEAD)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "file":
        return await undoFile(params.file, params.ref, ctx)
      case "last_edit":
        return await undoLastEdit(params.file, ctx)
      case "preview":
        return await previewUndo(params.file, params.ref)
      case "list":
        return listUndoable()
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.undo" })

/** Restore a file to its state at a given ref. */
async function undoFile(
  file: string | undefined,
  ref: string | undefined,
  ctx: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!file) throw new Error("file parameter is required for file operation")
  const cwd = Instance.directory
  const absPath = path.isAbsolute(file) ? file : path.join(cwd, file)
  const relPath = path.relative(cwd, absPath)
  const gitRef = ref ?? "HEAD"

  // Check that the file exists in the ref
  const checkResult = await $`git show ${gitRef}:${relPath}`
    .cwd(cwd).quiet().nothrow()
  if (checkResult.exitCode !== 0) {
    throw new Error(`File ${relPath} does not exist at ref ${gitRef}`)
  }

  // Get current content for diff preview
  const currentContent = await Filesystem.readText(absPath).catch(() => "")
  const refContent = checkResult.text()

  if (currentContent === refContent) {
    return {
      title: `undo: ${relPath}`,
      metadata: { noChange: true },
      output: `File ${relPath} is already at the state of ${gitRef}. Nothing to undo.`,
    }
  }

  // Ask permission
  await ctx.ask({
    permission: "edit",
    patterns: [relPath],
    always: ["*"],
    metadata: {
      filepath: absPath,
      diff: `Restoring ${relPath} to state at ${gitRef}`,
    },
  })

  // Snapshot before undo so this is itself undoable
  await Snapshot.track()

  // Restore file
  await $`git checkout ${gitRef} -- ${relPath}`.cwd(cwd).quiet().nothrow()

  // Publish events
  await Bus.publish(File.Event.Edited, { file: absPath })
  await Bus.publish(FileWatcher.Event.Updated, { file: absPath, event: "change" })

  // Record in changelog
  Changelog.record({
    file: absPath,
    operation: "edit",
    toolID: "undo",
    summary: `Restored to ${gitRef}`,
  })

  const linesDiff = countLineDiff(refContent, currentContent)
  return {
    title: `undo: ${relPath}`,
    metadata: { ref: gitRef, additions: linesDiff.additions, deletions: linesDiff.deletions },
    output: `Restored ${relPath} to state at ${gitRef}. (+${linesDiff.additions}/-${linesDiff.deletions} lines)`,
  }
}

/** Undo the most recent edit to a specific file. */
async function undoLastEdit(
  file: string | undefined,
  ctx: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!file) throw new Error("file parameter is required for last_edit operation")
  const cwd = Instance.directory
  const absPath = path.isAbsolute(file) ? file : path.join(cwd, file)
  const relPath = path.relative(cwd, absPath)

  // Find the last changelog entry with a snapshotBefore for this file
  const history = Changelog.forFile(absPath)
  const lastWithSnapshot = [...history].reverse().find((e) => e.snapshotBefore)

  if (lastWithSnapshot?.snapshotBefore) {
    // We have a snapshot — restore from it
    await ctx.ask({
      permission: "edit",
      patterns: [relPath],
      always: ["*"],
      metadata: {
        filepath: absPath,
        diff: `Undoing last edit to ${relPath} (restoring to snapshot ${lastWithSnapshot.snapshotBefore.slice(0, 8)})`,
      },
    })

    await Snapshot.track()

    // Restore just this file from the snapshot
    const git = path.join(
      (await import("../global")).Global.Path.data,
      "snapshot",
      Instance.project.id,
    )
    const restoreResult =
      await $`git -c core.longpaths=true -c core.symlinks=true --git-dir ${git} --work-tree ${Instance.worktree} checkout ${lastWithSnapshot.snapshotBefore} -- ${absPath}`
        .quiet().cwd(Instance.worktree).nothrow()

    if (restoreResult.exitCode !== 0) {
      throw new Error(`Failed to restore ${relPath} from snapshot: ${restoreResult.stderr.toString()}`)
    }

    await Bus.publish(File.Event.Edited, { file: absPath })
    await Bus.publish(FileWatcher.Event.Updated, { file: absPath, event: "change" })

    Changelog.record({
      file: absPath,
      operation: "edit",
      toolID: "undo",
      summary: `Undid last edit (restored from snapshot)`,
    })

    return {
      title: `undo last_edit: ${relPath}`,
      metadata: { snapshot: lastWithSnapshot.snapshotBefore.slice(0, 8) },
      output: `Undid last edit to ${relPath}. Restored from snapshot ${lastWithSnapshot.snapshotBefore.slice(0, 8)}.`,
    }
  }

  // Fallback: restore from HEAD
  return undoFile(file, "HEAD", ctx)
}

/** Preview what an undo operation would do. */
async function previewUndo(
  file: string | undefined,
  ref: string | undefined,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!file) throw new Error("file parameter is required for preview operation")
  const cwd = Instance.directory
  const absPath = path.isAbsolute(file) ? file : path.join(cwd, file)
  const relPath = path.relative(cwd, absPath)
  const gitRef = ref ?? "HEAD"

  const checkResult = await $`git show ${gitRef}:${relPath}`
    .cwd(cwd).quiet().nothrow()
  if (checkResult.exitCode !== 0) {
    return {
      title: `undo preview: ${relPath}`,
      metadata: { exists: false },
      output: `File ${relPath} does not exist at ${gitRef}. Undo would delete the file.`,
    }
  }

  // Show what the reverse diff would look like
  const reverseDiff = await $`git -c core.quotepath=false diff --no-ext-diff ${gitRef} -- ${relPath}`
    .cwd(cwd).quiet().nothrow().text()

  if (!reverseDiff.trim()) {
    return {
      title: `undo preview: ${relPath}`,
      metadata: { noChange: true },
      output: `File ${relPath} is already at the state of ${gitRef}. Nothing to undo.`,
    }
  }

  // Show reverse (what restoring would look like)
  const diff = await $`git -c core.quotepath=false diff --no-ext-diff -- ${relPath}`
    .cwd(cwd).quiet().nothrow().text()

  return {
    title: `undo preview: ${relPath}`,
    metadata: { ref: gitRef },
    output: `Restoring ${relPath} to ${gitRef} would apply this reverse diff:\n\n${diff.trim() || reverseDiff.trim()}`,
  }
}

/** List all undoable edits. */
function listUndoable(): { title: string; metadata: Record<string, any>; output: string } {
  const all = Changelog.all()
  // Filter to only tool-initiated edits (not external)
  const undoable = all.filter(
    (e) => e.operation !== "external" && e.toolID !== "undo",
  )

  if (undoable.length === 0) {
    return {
      title: "undo: list",
      metadata: { count: 0 },
      output: "No undoable edits in this session.",
    }
  }

  const lines = undoable.map((e) => {
    const rel = path.relative(Instance.directory, e.file)
    const time = new Date(e.timestamp).toLocaleTimeString()
    const stats = e.additions || e.deletions ? ` (+${e.additions}/-${e.deletions})` : ""
    const snap = e.snapshotBefore ? ` [snapshot: ${e.snapshotBefore.slice(0, 8)}]` : ""
    return `#${e.id} [${time}] ${e.operation} ${rel}${stats}${snap}${e.summary ? ` — ${e.summary}` : ""}`
  })

  return {
    title: "undo: list",
    metadata: { count: undoable.length },
    output: `${undoable.length} undoable edit(s):\n\n${lines.join("\n")}`,
  }
}

/** Count line differences between two strings. */
function countLineDiff(a: string, b: string): { additions: number; deletions: number } {
  const aLines = new Set(a.split("\n"))
  const bLines = new Set(b.split("\n"))
  let additions = 0
  let deletions = 0
  for (const line of aLines) {
    if (!bLines.has(line)) additions++
  }
  for (const line of bLines) {
    if (!aLines.has(line)) deletions++
  }
  return { additions, deletions }
}
