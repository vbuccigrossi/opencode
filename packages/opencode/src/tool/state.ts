import z from "zod"
import { Tool } from "./tool"
import { SessionState } from "../session/state"

/**
 * State tool — allows the agent to manage a structured session state
 * that survives compaction.
 *
 * Each operation is stored as a tool call input (delta). The full state
 * is reconstructed by replaying all state tool calls via SessionState.extract().
 * Since tool inputs survive compaction (only outputs are cleared), the
 * agent's structured state persists across the entire session.
 *
 * State includes:
 * - Goal: what the agent is trying to accomplish
 * - Plan: ordered steps with statuses and dependencies
 * - Decisions: choices made with reasoning and alternatives
 * - Failed approaches: what didn't work and why (prevents retrying)
 * - Working set: files currently being worked on
 * - Invariants: constraints that must hold
 * - Checkpoint: a reference point (commit hash, snapshot ID, etc.)
 */

const PlanStepSchema = z.object({
  id: z.string().describe("Unique step identifier (e.g. 's1', 's2')"),
  step: z.string().describe("Description of what this step does"),
  status: z
    .enum(["pending", "active", "done", "failed", "skipped"])
    .default("pending")
    .describe("Current status of this step"),
  notes: z.string().optional().describe("Additional notes about this step"),
  dependencies: z
    .array(z.string())
    .optional()
    .describe("IDs of steps that must complete before this one"),
})

export const StateTool = Tool.define("state", {
  description: [
    "Manage structured session state that survives compaction.",
    "Use this to track your goal, plan, decisions, failures, and working context.",
    "",
    "Operations:",
    "- init: Initialize state with a goal and plan. Use at the start of any non-trivial task (>2 steps).",
    "- update_plan: Update a step's status or add new steps. Use as you begin or complete steps.",
    "- add_decision: Record a decision with reasoning. Use when choosing between approaches.",
    "- record_failure: Record a failed approach. Use when something doesn't work (prevents retrying).",
    "- update_working_set: Add/remove files from your working set. Use when you start/stop working on files.",
    "- add_invariant: Add a constraint that must hold. Use to record things that must not break.",
    "- set_checkpoint: Record a checkpoint ref (commit hash, etc.). Use before risky changes.",
    "- get: Review your current state. Use before making decisions to stay on track.",
    "",
    "The state is reconstructed from all state tool calls in the conversation,",
    "so it survives compaction. Each call is a delta that gets replayed.",
  ].join("\n"),
  parameters: z.object({
    operation: z
      .enum([
        "init",
        "update_plan",
        "add_decision",
        "record_failure",
        "update_working_set",
        "add_invariant",
        "set_checkpoint",
        "get",
      ])
      .describe("The state operation to perform"),

    // For init:
    goal: z.string().optional().describe("The goal for this task (required for init)"),
    plan: z
      .array(PlanStepSchema)
      .optional()
      .describe("Initial plan steps (required for init)"),

    // For update_plan:
    step_id: z
      .string()
      .optional()
      .describe("ID of the step to update (for update_plan)"),
    step_status: z
      .enum(["pending", "active", "done", "failed", "skipped"])
      .optional()
      .describe("New status for the step (for update_plan)"),
    step_notes: z
      .string()
      .optional()
      .describe("Notes to attach to the step (for update_plan)"),
    new_steps: z
      .array(PlanStepSchema)
      .optional()
      .describe("Additional steps to append to the plan (for update_plan)"),

    // For add_decision:
    choice: z
      .string()
      .optional()
      .describe("What was decided (required for add_decision)"),
    reason: z
      .string()
      .optional()
      .describe("Why this choice was made (for add_decision)"),
    alternatives: z
      .array(z.string())
      .optional()
      .describe("Other options that were considered (for add_decision)"),

    // For record_failure:
    approach: z
      .string()
      .optional()
      .describe("Description of the approach that failed (required for record_failure)"),
    failure_reason: z
      .string()
      .optional()
      .describe("Why it failed (for record_failure)"),

    // For update_working_set:
    add_files: z
      .array(z.string())
      .optional()
      .describe("File paths to add to the working set (for update_working_set)"),
    remove_files: z
      .array(z.string())
      .optional()
      .describe("File paths to remove from the working set (for update_working_set)"),

    // For add_invariant:
    invariant: z
      .string()
      .optional()
      .describe("A constraint that must hold (required for add_invariant)"),

    // For set_checkpoint:
    checkpoint: z
      .string()
      .optional()
      .describe("A reference point, e.g. commit hash or snapshot ID (required for set_checkpoint)"),
  }),
  async execute(params, ctx) {
    switch (params.operation) {
      case "init":
        return executeInit(params)
      case "update_plan":
        return executeUpdatePlan(params, ctx)
      case "add_decision":
        return executeAddDecision(params)
      case "record_failure":
        return executeRecordFailure(params)
      case "update_working_set":
        return executeUpdateWorkingSet(params, ctx)
      case "add_invariant":
        return executeAddInvariant(params)
      case "set_checkpoint":
        return executeSetCheckpoint(params)
      case "get":
        return executeGet(ctx)
    }
  },
})

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

/** Initialize state with a goal and plan. */
function executeInit(params: {
  goal?: string
  plan?: Array<{ id: string; step: string; status?: string; notes?: string; dependencies?: string[] }>
}): { title: string; output: string; metadata: { truncated: false } } {
  if (!params.goal) {
    return {
      title: "Error",
      output: "The 'goal' parameter is required for the init operation.",
      metadata: { truncated: false },
    }
  }
  if (!params.plan || params.plan.length === 0) {
    return {
      title: "Error",
      output: "The 'plan' parameter (non-empty array) is required for the init operation.",
      metadata: { truncated: false },
    }
  }

  const n = params.plan.length
  return {
    title: "State initialized",
    output: `State initialized. Goal: ${params.goal}. Plan: ${n} step${n !== 1 ? "s" : ""}.`,
    metadata: { truncated: false },
  }
}

/** Update plan step statuses or add new steps. */
function executeUpdatePlan(
  params: {
    step_id?: string
    step_status?: string
    step_notes?: string
    new_steps?: Array<{ id: string; step: string; status?: string; notes?: string; dependencies?: string[] }>
  },
  ctx: Tool.Context,
): { title: string; output: string; metadata: { truncated: false } } {
  const parts: string[] = []

  if (params.step_id && params.step_status) {
    parts.push(`Step '${params.step_id}' marked as ${params.step_status}.`)
  } else if (params.step_id && !params.step_status && params.step_notes) {
    parts.push(`Notes added to step '${params.step_id}'.`)
  }

  if (params.new_steps && params.new_steps.length > 0) {
    parts.push(`${params.new_steps.length} new step${params.new_steps.length !== 1 ? "s" : ""} added.`)
  }

  if (parts.length === 0) {
    return {
      title: "Error",
      output:
        "update_plan requires at least one of: step_id + step_status, step_id + step_notes, or new_steps.",
      metadata: { truncated: false },
    }
  }

  // Reconstruct current state to report plan progress
  const state = SessionState.extract(ctx.messages) ?? SessionState.empty()
  const done = state.plan.filter((s) => s.status === "done").length
  const total = state.plan.length + (params.new_steps?.length ?? 0)

  return {
    title: "Plan updated",
    output: `${parts.join(" ")} Progress: ${done}/${total}.`,
    metadata: { truncated: false },
  }
}

/** Record a decision. */
function executeAddDecision(params: {
  choice?: string
  reason?: string
  alternatives?: string[]
}): { title: string; output: string; metadata: { truncated: false } } {
  if (!params.choice) {
    return {
      title: "Error",
      output: "The 'choice' parameter is required for the add_decision operation.",
      metadata: { truncated: false },
    }
  }

  return {
    title: "Decision recorded",
    output: `Decision recorded: ${params.choice}`,
    metadata: { truncated: false },
  }
}

/** Record a failed approach. */
function executeRecordFailure(params: {
  approach?: string
  failure_reason?: string
}): { title: string; output: string; metadata: { truncated: false } } {
  if (!params.approach) {
    return {
      title: "Error",
      output: "The 'approach' parameter is required for the record_failure operation.",
      metadata: { truncated: false },
    }
  }

  return {
    title: "Failure recorded",
    output: `Failed approach recorded: ${params.approach}`,
    metadata: { truncated: false },
  }
}

/** Add or remove files from the working set. */
function executeUpdateWorkingSet(
  params: {
    add_files?: string[]
    remove_files?: string[]
  },
  ctx: Tool.Context,
): { title: string; output: string; metadata: { truncated: false } } {
  if (
    (!params.add_files || params.add_files.length === 0) &&
    (!params.remove_files || params.remove_files.length === 0)
  ) {
    return {
      title: "Error",
      output: "At least one of 'add_files' or 'remove_files' is required for update_working_set.",
      metadata: { truncated: false },
    }
  }

  // Reconstruct to report current count
  const state = SessionState.extract(ctx.messages) ?? SessionState.empty()
  const currentFiles = new Set(state.workingSet)
  if (params.add_files) {
    for (const f of params.add_files) currentFiles.add(f)
  }
  if (params.remove_files) {
    for (const f of params.remove_files) currentFiles.delete(f)
  }

  return {
    title: "Working set updated",
    output: `Working set updated. ${currentFiles.size} file${currentFiles.size !== 1 ? "s" : ""}.`,
    metadata: { truncated: false },
  }
}

/** Add a constraint/invariant. */
function executeAddInvariant(params: {
  invariant?: string
}): { title: string; output: string; metadata: { truncated: false } } {
  if (!params.invariant) {
    return {
      title: "Error",
      output: "The 'invariant' parameter is required for the add_invariant operation.",
      metadata: { truncated: false },
    }
  }

  return {
    title: "Invariant added",
    output: `Invariant added: ${params.invariant}`,
    metadata: { truncated: false },
  }
}

/** Record a checkpoint reference. */
function executeSetCheckpoint(params: {
  checkpoint?: string
}): { title: string; output: string; metadata: { truncated: false } } {
  if (!params.checkpoint) {
    return {
      title: "Error",
      output: "The 'checkpoint' parameter is required for the set_checkpoint operation.",
      metadata: { truncated: false },
    }
  }

  return {
    title: "Checkpoint set",
    output: `Checkpoint set: ${params.checkpoint}`,
    metadata: { truncated: false },
  }
}

/** Return the full formatted state. */
function executeGet(
  ctx: Tool.Context,
): { title: string; output: string; metadata: { truncated: false } } {
  const state = SessionState.extract(ctx.messages) ?? SessionState.empty()
  const formatted = SessionState.format(state)

  return {
    title: "Current state",
    output: formatted,
    metadata: { truncated: false },
  }
}
