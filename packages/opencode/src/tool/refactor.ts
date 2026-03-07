import z from "zod"
import { Tool } from "./tool"
import { Refactor } from "../refactor"

/**
 * Refactor tool — multi-file atomic refactoring with validation and rollback.
 *
 * Operations:
 * - plan: Create a new refactoring plan
 * - add_edit: Stage a file edit in a plan
 * - validate: Validate all edits in a plan
 * - apply: Apply all edits atomically
 * - rollback: Restore original files
 * - rename: Rename a symbol across files (creates a full plan)
 * - diff: Preview the changes in a plan
 * - list: List all plans
 */
export const RefactorTool = Tool.define("refactor", {
  description: `Multi-file atomic refactoring with validation and rollback.

Operations:
- plan: Create a refactoring plan (returns plan_id for subsequent operations)
- add_edit: Stage a file edit in a plan (no disk writes until apply)
- validate: Check all edits for conflicts
- apply: Write all edits to disk atomically
- rollback: Restore original files after a failed refactoring
- rename: Rename a symbol across multiple files (auto-creates plan)
- diff: Preview the complete diff of a plan
- list: Show all plans and their status

Use this for multi-file changes that need to succeed or fail as a unit:
- Renaming a symbol across imports and references
- Moving a function and updating all importers
- Changing a type signature and fixing all consumers

The plan → validate → apply workflow ensures no partial edits leave the codebase broken.`,
  parameters: z.object({
    operation: z
      .enum(["plan", "add_edit", "validate", "apply", "rollback", "rename", "diff", "list"])
      .describe("The refactoring operation to perform"),
    description: z
      .string()
      .optional()
      .describe("Plan description (required for plan)"),
    plan_id: z
      .string()
      .optional()
      .describe("Plan ID (required for add_edit, validate, apply, rollback, diff)"),
    file_path: z
      .string()
      .optional()
      .describe("File path (required for add_edit)"),
    old_content: z
      .string()
      .optional()
      .describe("Original file content (required for add_edit)"),
    new_content: z
      .string()
      .optional()
      .describe("New file content (required for add_edit)"),
    edit_description: z
      .string()
      .optional()
      .describe("Description of this edit (for add_edit)"),
    old_name: z
      .string()
      .optional()
      .describe("Current symbol name (required for rename)"),
    new_name: z
      .string()
      .optional()
      .describe("New symbol name (required for rename)"),
    files: z
      .array(z.string())
      .optional()
      .describe("Files to scan for rename"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "plan":
        return refactorPlan(params.description)
      case "add_edit":
        return refactorAddEdit(params.plan_id, params.file_path, params.old_content, params.new_content, params.edit_description)
      case "validate":
        return await refactorValidate(params.plan_id)
      case "apply":
        return await refactorApply(params.plan_id)
      case "rollback":
        return await refactorRollback(params.plan_id)
      case "rename":
        return await refactorRename(params.old_name, params.new_name, params.files)
      case "diff":
        return refactorDiff(params.plan_id)
      case "list":
        return refactorList()
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
})

function refactorPlan(description?: string) {
  if (!description) throw new Error("description is required for plan operation")
  const p = Refactor.plan(description)
  return {
    title: `refactor: plan ${p.id}`,
    metadata: { truncated: false, planId: p.id },
    output: `Created refactoring plan ${p.id}: "${description}"\nUse add_edit to stage edits, then validate and apply.`,
  }
}

function refactorAddEdit(planId?: string, filePath?: string, oldContent?: string, newContent?: string, description?: string) {
  if (!planId) throw new Error("plan_id is required for add_edit")
  if (!filePath) throw new Error("file_path is required for add_edit")
  if (oldContent === undefined) throw new Error("old_content is required for add_edit")
  if (newContent === undefined) throw new Error("new_content is required for add_edit")

  Refactor.addEdit(planId, {
    filePath,
    oldContent,
    newContent,
    description: description ?? `Edit ${filePath}`,
  })

  const p = Refactor.get(planId)!
  return {
    title: `refactor: edit added to ${planId}`,
    metadata: { truncated: false, planId, editCount: p.edits.length },
    output: `Edit staged: ${description ?? filePath}\nPlan ${planId} now has ${p.edits.length} edit(s). Use validate to check.`,
  }
}

async function refactorValidate(planId?: string) {
  if (!planId) throw new Error("plan_id is required for validate")
  const p = await Refactor.validate(planId)
  return {
    title: `refactor: validate ${p.validation?.success ? "PASS" : "FAIL"}`,
    metadata: { truncated: false, planId, success: p.validation?.success },
    output: Refactor.formatPlan(p),
  }
}

async function refactorApply(planId?: string) {
  if (!planId) throw new Error("plan_id is required for apply")
  const p = await Refactor.apply(planId)
  return {
    title: `refactor: applied ${planId}`,
    metadata: { truncated: false, planId, filesChanged: p.edits.length },
    output: `Applied ${p.edits.length} edit(s) successfully.\n${Refactor.formatPlan(p)}`,
  }
}

async function refactorRollback(planId?: string) {
  if (!planId) throw new Error("plan_id is required for rollback")
  const p = await Refactor.rollback(planId)
  return {
    title: `refactor: rolled back ${planId}`,
    metadata: { truncated: false, planId },
    output: `Rolled back plan ${planId}. All files restored to original state.`,
  }
}

async function refactorRename(oldName?: string, newName?: string, files?: string[]) {
  if (!oldName) throw new Error("old_name is required for rename")
  if (!newName) throw new Error("new_name is required for rename")
  if (!files || files.length === 0) throw new Error("files is required for rename")

  const p = await Refactor.renameSymbol(oldName, newName, files)
  return {
    title: `refactor: rename plan ${p.id}`,
    metadata: { truncated: false, planId: p.id, editCount: p.edits.length },
    output: `Rename plan created: ${p.id}\n${Refactor.formatPlan(p)}\nUse validate then apply to execute.`,
  }
}

function refactorDiff(planId?: string) {
  if (!planId) throw new Error("plan_id is required for diff")
  return {
    title: `refactor: diff ${planId}`,
    metadata: { truncated: false, planId },
    output: Refactor.diff(planId),
  }
}

function refactorList() {
  const plans = Refactor.list()
  if (plans.length === 0) {
    return {
      title: "refactor: list",
      metadata: { truncated: false, count: 0 },
      output: "No refactoring plans.",
    }
  }

  const lines = plans.map((p) =>
    `${p.id} [${p.status}] ${p.description} — ${p.edits.length} edit(s)`,
  )
  return {
    title: "refactor: list",
    metadata: { truncated: false, count: plans.length },
    output: `${plans.length} plan(s):\n${lines.join("\n")}`,
  }
}
