import z from "zod"
import { Tool } from "./tool"
import { Staging } from "../staging"

/**
 * Staging tool — stage file edits in memory before writing to disk.
 *
 * Operations:
 * - create: Create a new staging area
 * - stage: Stage a file edit (with explicit original+proposed)
 * - diff: Preview the full diff of staged changes
 * - apply: Write all staged edits to disk
 * - discard: Discard all staged edits
 * - unstage: Remove a single file from staging
 * - list: List all staging areas
 * - info: Get details about a staging area
 */
export const StagingTool = Tool.define("staging", {
  description: `Stage file edits in memory and preview before writing to disk.

Operations:
- create: Create a new staging area (returns area_id)
- stage: Stage a file edit with original and proposed content
- diff: Preview the unified diff of all staged changes
- apply: Write all staged edits to disk
- discard: Throw away staged changes without writing
- unstage: Remove one file from the staging area
- list: Show all staging areas
- info: Get details about a specific staging area

Use this when you want to:
- Preview a batch of file changes before committing them
- Stage multiple related edits and review the full diff
- Discard changes that don't look right without touching disk`,
  parameters: z.object({
    operation: z
      .enum(["create", "stage", "diff", "apply", "discard", "unstage", "list", "info"])
      .describe("The staging operation to perform"),
    description: z
      .string()
      .optional()
      .describe("Description (required for create)"),
    area_id: z
      .string()
      .optional()
      .describe("Staging area ID (required for stage, diff, apply, discard, unstage, info)"),
    file_path: z
      .string()
      .optional()
      .describe("File path (required for stage, unstage)"),
    original: z
      .string()
      .optional()
      .describe("Original file content (required for stage)"),
    proposed: z
      .string()
      .optional()
      .describe("Proposed new content (required for stage)"),
    edit_description: z
      .string()
      .optional()
      .describe("Description of this edit (for stage)"),
  }),
  async execute(params): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "create":
        return stagingCreate(params.description)
      case "stage":
        return stagingStage(params.area_id, params.file_path, params.original, params.proposed, params.edit_description)
      case "diff":
        return stagingDiff(params.area_id)
      case "apply":
        return await stagingApply(params.area_id)
      case "discard":
        return stagingDiscard(params.area_id)
      case "unstage":
        return stagingUnstage(params.area_id, params.file_path)
      case "list":
        return stagingList()
      case "info":
        return stagingInfo(params.area_id)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
})

function stagingCreate(description?: string) {
  if (!description) throw new Error("description is required for create")
  const area = Staging.create(description)
  return {
    title: `staging: created ${area.id}`,
    metadata: { truncated: false, areaId: area.id },
    output: `Created staging area ${area.id}: "${description}"\nUse stage to add file edits, then diff to preview and apply to write.`,
  }
}

function stagingStage(areaId?: string, filePath?: string, original?: string, proposed?: string, description?: string) {
  if (!areaId) throw new Error("area_id is required for stage")
  if (!filePath) throw new Error("file_path is required for stage")
  if (original === undefined) throw new Error("original is required for stage")
  if (proposed === undefined) throw new Error("proposed is required for stage")

  Staging.stageWithOriginal(areaId, filePath, original, proposed, description ?? `Edit ${filePath}`)
  const area = Staging.get(areaId)!
  return {
    title: `staging: staged ${filePath}`,
    metadata: { truncated: false, areaId, editCount: area.edits.length },
    output: `Staged edit for ${filePath}: ${description ?? "edit"}\nArea ${areaId} now has ${area.edits.length} edit(s). Use diff to preview.`,
  }
}

function stagingDiff(areaId?: string) {
  if (!areaId) throw new Error("area_id is required for diff")
  return {
    title: `staging: diff ${areaId}`,
    metadata: { truncated: false, areaId },
    output: Staging.diff(areaId),
  }
}

async function stagingApply(areaId?: string) {
  if (!areaId) throw new Error("area_id is required for apply")
  const count = await Staging.apply(areaId)
  return {
    title: `staging: applied ${areaId}`,
    metadata: { truncated: false, areaId, filesWritten: count },
    output: `Applied ${count} edit(s) from staging area ${areaId} to disk.`,
  }
}

function stagingDiscard(areaId?: string) {
  if (!areaId) throw new Error("area_id is required for discard")
  Staging.discard(areaId)
  return {
    title: `staging: discarded ${areaId}`,
    metadata: { truncated: false, areaId },
    output: `Discarded staging area ${areaId}. No files were modified.`,
  }
}

function stagingUnstage(areaId?: string, filePath?: string) {
  if (!areaId) throw new Error("area_id is required for unstage")
  if (!filePath) throw new Error("file_path is required for unstage")
  Staging.unstage(areaId, filePath)
  const area = Staging.get(areaId)!
  return {
    title: `staging: unstaged ${filePath}`,
    metadata: { truncated: false, areaId, editCount: area.edits.length },
    output: `Removed ${filePath} from staging area ${areaId}. ${area.edits.length} edit(s) remaining.`,
  }
}

function stagingList() {
  const all = Staging.list()
  if (all.length === 0) {
    return {
      title: "staging: list",
      metadata: { truncated: false, count: 0 },
      output: "No staging areas.",
    }
  }

  const lines = all.map((a) =>
    `${a.id} [${a.status}] ${a.description} — ${a.edits.length} edit(s)`,
  )
  return {
    title: "staging: list",
    metadata: { truncated: false, count: all.length },
    output: `${all.length} staging area(s):\n${lines.join("\n")}`,
  }
}

function stagingInfo(areaId?: string) {
  if (!areaId) throw new Error("area_id is required for info")
  return {
    title: `staging: info ${areaId}`,
    metadata: { truncated: false, areaId },
    output: Staging.format(areaId),
  }
}
