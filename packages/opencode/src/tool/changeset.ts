import z from "zod"
import { Tool } from "./tool"
import { Changeset } from "../changeset"
import { Log } from "../util/log"

/**
 * Atomic change set tool — build, preview, and apply multi-file edits
 * as a coherent unit that succeeds or fails atomically.
 *
 * Use this when you need to make coordinated changes across multiple files
 * where intermediate states would be invalid.
 */
export const ChangesetTool = Tool.define("changeset", async () => ({
  description: `Build and apply multi-file edits as an atomic unit.

Operations:
- create: Start a new named change set. Give it a descriptive name.
- add: Add a file edit to the change set. Provide the file path and proposed content.
- remove: Remove a file from the change set.
- preview: Show a unified diff of all changes across all files.
- apply: Write all files atomically. If any file fails, ALL changes are rolled back.
- rollback: Restore all files to their original content after an apply.
- discard: Discard a change set without applying.
- list: List all active change sets.
- status: Show summary of a specific change set.

Use this when you need to:
- Change a function signature AND update all call sites
- Rename/move exports across multiple files
- Make any multi-file change that would break the project if partially applied`,
  parameters: z.object({
    operation: z
      .enum(["create", "add", "remove", "preview", "apply", "rollback", "discard", "list", "status"])
      .describe("The changeset operation to perform"),
    name: z.string().optional().describe("Change set name (required for all except list)"),
    description: z.string().optional().describe("Description (for create)"),
    file_path: z.string().optional().describe("File path (for add, remove)"),
    content: z.string().optional().describe("Proposed file content (for add)"),
    original: z.string().optional().describe("Explicit original content (for add; reads from disk if omitted)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "create":
        return csCreate(params.name, params.description)
      case "add":
        return csAdd(params.name, params.file_path, params.content, params.original)
      case "remove":
        return csRemove(params.name, params.file_path)
      case "preview":
        return csPreview(params.name)
      case "apply":
        return csApply(params.name)
      case "rollback":
        return csRollback(params.name)
      case "discard":
        return csDiscard(params.name)
      case "list":
        return csList()
      case "status":
        return csStatus(params.name)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.changeset" })

function csCreate(name?: string, description?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!name) throw new Error("name is required for create")
  const cs = Changeset.create(name, description)
  return Promise.resolve({
    title: `changeset: created "${name}"`,
    metadata: { name },
    output: `Change set "${name}" created.${description ? ` Description: ${description}` : ""}\nUse changeset add to add file edits.`,
  })
}

function csAdd(
  name?: string,
  filePath?: string,
  content?: string,
  original?: string,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!name) throw new Error("name is required for add")
  if (!filePath) throw new Error("file_path is required for add")
  if (content === undefined) throw new Error("content is required for add")

  const cs = Changeset.addEdit(name, filePath, content, original)
  return Promise.resolve({
    title: `changeset: added ${filePath} to "${name}"`,
    metadata: { name, filePath, fileCount: cs.edits.length },
    output: `Added ${filePath} to change set "${name}". ${cs.edits.length} file(s) total.`,
  })
}

function csRemove(name?: string, filePath?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!name) throw new Error("name is required for remove")
  if (!filePath) throw new Error("file_path is required for remove")

  const cs = Changeset.removeEdit(name, filePath)
  return Promise.resolve({
    title: `changeset: removed ${filePath} from "${name}"`,
    metadata: { name, filePath, fileCount: cs.edits.length },
    output: `Removed ${filePath} from change set "${name}". ${cs.edits.length} file(s) remaining.`,
  })
}

function csPreview(name?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!name) throw new Error("name is required for preview")
  const output = Changeset.formatPreview(name)
  const hunks = Changeset.preview(name)
  return Promise.resolve({
    title: `changeset: preview "${name}" (${hunks.length} files)`,
    metadata: { name, fileCount: hunks.length },
    output,
  })
}

function csApply(name?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!name) throw new Error("name is required for apply")
  const files = Changeset.apply(name)
  return Promise.resolve({
    title: `changeset: applied "${name}" (${files.length} files)`,
    metadata: { name, files },
    output: `Change set "${name}" applied successfully. ${files.length} file(s) written:\n${files.join("\n")}`,
  })
}

function csRollback(name?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!name) throw new Error("name is required for rollback")
  const files = Changeset.rollback(name)
  return Promise.resolve({
    title: `changeset: rolled back "${name}" (${files.length} files)`,
    metadata: { name, files },
    output: `Change set "${name}" rolled back. ${files.length} file(s) restored to original content.`,
  })
}

function csDiscard(name?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!name) throw new Error("name is required for discard")
  Changeset.discard(name)
  return Promise.resolve({
    title: `changeset: discarded "${name}"`,
    metadata: { name },
    output: `Change set "${name}" discarded.`,
  })
}

function csList(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const sets = Changeset.list()
  const output = sets.length === 0
    ? "No active change sets."
    : sets.map((s) => `${s.name} [${s.status}] — ${s.fileCount} file(s)${s.description ? ` (${s.description})` : ""}`).join("\n")
  return Promise.resolve({
    title: `changeset: ${sets.length} active`,
    metadata: { count: sets.length },
    output,
  })
}

function csStatus(name?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!name) throw new Error("name is required for status")
  const cs = Changeset.get(name)
  if (!cs) throw new Error(`Change set "${name}" not found`)

  const lines = [
    `Change set: ${cs.name}`,
    `Status: ${cs.status}`,
    `Files: ${cs.edits.length}`,
    `Created: ${new Date(cs.createdAt).toISOString()}`,
    `Updated: ${new Date(cs.updatedAt).toISOString()}`,
  ]

  if (cs.description) lines.splice(1, 0, `Description: ${cs.description}`)

  if (cs.edits.length > 0) {
    lines.push("")
    lines.push("Files in change set:")
    for (const edit of cs.edits) {
      const tag = edit.isNew ? " (new)" : ""
      lines.push(`  ${edit.filePath}${tag}`)
    }
  }

  return Promise.resolve({
    title: `changeset: status "${name}"`,
    metadata: { name, status: cs.status, fileCount: cs.edits.length },
    output: lines.join("\n"),
  })
}
