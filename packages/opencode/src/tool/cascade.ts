import z from "zod"
import { Tool } from "./tool"
import { Cascade } from "../cascade"
import type { CascadeTransforms } from "../cascade/transforms"

/**
 * Cascade tool — propagate function signature changes to all call sites.
 *
 * Operations:
 * - plan: Find all callers and compute edits for a signature change
 * - preview: Show the exact edits that would be made
 * - apply: Write all edits to disk
 * - list: Show all cascade plans
 */
export const CascadeTool = Tool.define("cascade", {
  description: `Propagate function signature changes to all call sites automatically.

Operations:
- plan: Create a cascade plan (finds callers, computes edits)
- preview: Show the exact edits for each affected file
- apply: Write all edits to disk atomically
- list: Show all cascade plans

Transforms:
- add_param: Insert a new argument at a position with a default value
- remove_param: Remove an argument at a position
- rename_param: Rename a named parameter (object-style params)
- reorder_params: Reorder arguments to match a new signature
- change_type: Document a type change (no call-site edits needed)

Use this when you change a function's signature and need to update all callers.
Provide caller_files from the graph tool's callers operation.`,
  parameters: z.object({
    operation: z
      .enum(["plan", "preview", "apply", "list"])
      .describe("The cascade operation to perform"),
    symbol_name: z
      .string()
      .optional()
      .describe("Function name whose signature changed (required for plan)"),
    transform_type: z
      .enum(["add_param", "remove_param", "rename_param", "reorder_params", "change_type"])
      .optional()
      .describe("Type of signature change (required for plan)"),
    position: z
      .number()
      .optional()
      .describe("Parameter position (for add_param, remove_param). -1 = append."),
    default_value: z
      .string()
      .optional()
      .describe("Default value expression (for add_param)"),
    param_name: z
      .string()
      .optional()
      .describe("Parameter name (for add_param name, rename_param old name)"),
    new_name: z
      .string()
      .optional()
      .describe("New parameter name (for rename_param)"),
    new_order: z
      .array(z.number())
      .optional()
      .describe("New parameter order as original positions (for reorder_params)"),
    description: z
      .string()
      .optional()
      .describe("Description of type change (for change_type)"),
    caller_files: z
      .array(z.string())
      .optional()
      .describe("Files containing calls to the function (from graph callers)"),
    plan_id: z
      .string()
      .optional()
      .describe("Cascade plan ID (for preview, apply)"),
  }),
  async execute(params): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "plan":
        return await cascadePlan(params)
      case "preview":
        return cascadePreview(params.plan_id)
      case "apply":
        return await cascadeApply(params.plan_id)
      case "list":
        return cascadeList()
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
})

async function cascadePlan(params: Record<string, any>) {
  if (!params.symbol_name) throw new Error("symbol_name is required for plan")
  if (!params.transform_type) throw new Error("transform_type is required for plan")
  if (!params.caller_files || params.caller_files.length === 0) {
    throw new Error("caller_files is required for plan (get them from the graph tool's callers operation)")
  }

  const transform = buildTransform(params)
  const plan = await Cascade.plan(params.symbol_name, transform, params.caller_files)

  const totalSites = plan.affectedFiles.reduce((s, f) => s + f.callSites.length, 0)
  return {
    title: `cascade: ${plan.affectedFiles.length} file(s), ${totalSites} site(s)`,
    metadata: {
      truncated: false,
      planId: plan.id,
      filesAffected: plan.affectedFiles.length,
      callSites: totalSites,
    },
    output: Cascade.preview(plan.id),
  }
}

function cascadePreview(planId?: string) {
  if (!planId) throw new Error("plan_id is required for preview")
  return {
    title: `cascade: preview ${planId}`,
    metadata: { truncated: false, planId },
    output: Cascade.preview(planId),
  }
}

async function cascadeApply(planId?: string) {
  if (!planId) throw new Error("plan_id is required for apply")
  const count = await Cascade.apply(planId)
  return {
    title: `cascade: applied ${planId} (${count} files)`,
    metadata: { truncated: false, planId, filesWritten: count },
    output: `Applied cascade ${planId}: ${count} file(s) updated.`,
  }
}

function cascadeList() {
  const plans = Cascade.list()
  if (plans.length === 0) {
    return {
      title: "cascade: list",
      metadata: { truncated: false, count: 0 },
      output: "No cascade plans.",
    }
  }

  const lines = plans.map((p) => Cascade.format(p.id))
  return {
    title: "cascade: list",
    metadata: { truncated: false, count: plans.length },
    output: `${plans.length} cascade plan(s):\n${lines.join("\n")}`,
  }
}

/** Build a TransformDetails from tool parameters. */
function buildTransform(params: Record<string, any>): CascadeTransforms.TransformDetails {
  switch (params.transform_type) {
    case "add_param":
      return {
        type: "add_param",
        position: params.position ?? -1,
        defaultValue: params.default_value ?? "undefined",
        name: params.param_name,
      }
    case "remove_param":
      if (params.position === undefined) throw new Error("position is required for remove_param")
      return {
        type: "remove_param",
        position: params.position,
      }
    case "rename_param":
      if (!params.param_name) throw new Error("param_name is required for rename_param")
      if (!params.new_name) throw new Error("new_name is required for rename_param")
      return {
        type: "rename_param",
        oldName: params.param_name,
        newName: params.new_name,
      }
    case "reorder_params":
      if (!params.new_order) throw new Error("new_order is required for reorder_params")
      return {
        type: "reorder_params",
        newOrder: params.new_order,
      }
    case "change_type":
      return {
        type: "change_type",
        description: params.description ?? "Type signature changed",
      }
    default:
      throw new Error(`Unknown transform type: ${params.transform_type}`)
  }
}
