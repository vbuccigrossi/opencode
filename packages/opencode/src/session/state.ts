import { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"

/**
 * SessionState — structured state object that the agent maintains throughout
 * a session. Unlike prose summaries, this state survives compaction because it
 * is stored in tool call **inputs** (which compaction preserves).
 *
 * The state gives the agent perfect situational awareness: its current goal,
 * plan progress, active working set, recorded decisions, invariants, and
 * failed approaches. On each step the most recent state is extracted from
 * conversation messages, formatted as a compact XML block, and injected into
 * the system prompt.
 *
 * Persistence mechanism:
 * - A `state` tool call stores the FULL current state as its JSON input.
 * - Tool inputs survive compaction (only outputs are cleared).
 * - `extract()` scans messages backwards for the latest state tool call.
 */
export namespace SessionState {
  const log = Log.create({ service: "session-state" })

  /** Tool name used to persist state in conversation messages. */
  export const TOOL_NAME = "state"

  // ─── Schema ────────────────────────────────────────────────────

  /**
   * A single step in the agent's plan.
   *
   * @property id - Unique identifier for referencing in dependencies
   * @property step - Human-readable description of the step
   * @property status - Current lifecycle status
   * @property notes - Optional freeform notes (e.g., what was learned)
   * @property dependencies - IDs of steps that must complete first
   */
  export interface PlanStep {
    id: string
    step: string
    status: "pending" | "active" | "done" | "failed" | "skipped"
    notes?: string
    dependencies?: string[]
  }

  /**
   * A recorded architectural or implementation decision.
   *
   * @property choice - What was decided
   * @property reason - Why this choice was made
   * @property alternatives - Other options that were considered
   * @property timestamp - When the decision was made (epoch ms)
   */
  export interface Decision {
    choice: string
    reason: string
    alternatives?: string[]
    timestamp: number
  }

  /**
   * A failed approach that should not be retried.
   *
   * @property approach - What was attempted
   * @property reason - Why it failed
   * @property timestamp - When the failure was recorded (epoch ms)
   */
  export interface FailedApproach {
    approach: string
    reason: string
    timestamp: number
  }

  /**
   * The full session state schema.
   *
   * @property version - Schema version for forward compatibility
   * @property goal - The top-level objective the agent is pursuing
   * @property plan - Ordered list of steps to achieve the goal
   * @property workingSet - Files currently relevant to the task
   * @property decisions - Recorded decisions with rationale
   * @property invariants - Constraints that must hold (e.g., "do not break existing API")
   * @property failedApproaches - Approaches that were tried and failed
   * @property checkpoint - Optional git ref for rollback
   * @property metadata - Arbitrary key-value pairs for extensibility
   */
  export interface State {
    version: 1
    goal: string
    plan: PlanStep[]
    workingSet: string[]
    decisions: Decision[]
    invariants: string[]
    failedApproaches: FailedApproach[]
    checkpoint?: string
    metadata: Record<string, unknown>
  }

  /** Valid plan step statuses for type-safe checks. */
  export const PLAN_STATUSES = ["pending", "active", "done", "failed", "skipped"] as const
  export type PlanStatus = (typeof PLAN_STATUSES)[number]

  // ─── Core Operations ──────────────────────────────────────────

  /**
   * Creates a default empty state, optionally seeded with a goal.
   *
   * @param goal - Initial goal description (defaults to empty string)
   * @returns A fresh State with all arrays empty
   */
  export function empty(goal?: string): State {
    return {
      version: 1,
      goal: goal ?? "",
      plan: [],
      workingSet: [],
      decisions: [],
      invariants: [],
      failedApproaches: [],
      metadata: {},
    }
  }

  /**
   * Merges a partial update into an existing state.
   *
   * Array fields (plan, workingSet, decisions, invariants, failedApproaches)
   * are replaced wholesale when present in the update — they are not
   * deep-merged, because the agent controls the full list each time.
   *
   * The metadata field is shallow-merged so individual keys can be
   * set without replacing the entire object.
   *
   * @param current - The existing state
   * @param update - Partial state fields to apply
   * @returns A new State with updates applied (does not mutate current)
   */
  export function merge(current: State, update: Partial<State>): State {
    const merged: State = {
      ...current,
      ...update,
      version: 1, // always pin version
      metadata: {
        ...current.metadata,
        ...(update.metadata ?? {}),
      },
    }
    return merged
  }

  /**
   * Extracts the current session state by replaying all state tool call
   * deltas from conversation messages.
   *
   * Scans messages forward (oldest first). Each state tool call's input
   * contains an operation + parameters (a delta). The state is built up
   * incrementally by applying each delta in order.
   *
   * This is robust against compaction because tool inputs always survive
   * (compaction only clears tool outputs of non-protected tools, and
   * "state" is in the protected list).
   *
   * @param messages - Conversation messages with parts
   * @returns The reconstructed State, or undefined if no init found
   */
  export function extract(messages: MessageV2.WithParts[]): State | undefined {
    let state: State | undefined

    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue

      for (const part of msg.parts) {
        if (
          part.type === "tool" &&
          part.tool === TOOL_NAME &&
          (part.state.status === "completed" || part.state.status === "error")
        ) {
          const input = part.state.input
          if (input && typeof input === "object") {
            state = applyOperation(state, input as Record<string, unknown>)
          }
        }
      }
    }

    return state
  }

  /**
   * Applies a single state tool call's operation to the current state.
   *
   * @param current - Current state (may be undefined before init)
   * @param input - Raw tool call input with operation + parameters
   * @returns Updated state
   */
  export function applyOperation(current: State | undefined, input: Record<string, unknown>): State | undefined {
    const op = input.operation as string

    if (op === "init") {
      const goal = input.goal as string
      if (!goal) return current
      const state = empty(goal)
      if (Array.isArray(input.plan)) {
        state.plan = parsePlan(input.plan)
      }
      return state
    }

    // All other operations require existing state
    if (!current) return current

    switch (op) {
      case "update_plan": {
        const stepId = input.step_id as string
        if (stepId) {
          for (const step of current.plan) {
            if (step.id === stepId) {
              if (typeof input.step_status === "string" && PLAN_STATUSES.includes(input.step_status as PlanStatus)) {
                step.status = input.step_status as PlanStatus
              }
              if (typeof input.step_notes === "string") {
                step.notes = input.step_notes
              }
            }
          }
        }
        if (Array.isArray(input.new_steps)) {
          current.plan.push(...parsePlan(input.new_steps))
        }
        return current
      }

      case "add_decision": {
        const choice = input.choice as string
        if (choice) {
          current.decisions.push({
            choice,
            reason: (input.reason as string) ?? "",
            alternatives: parseStringArray(input.alternatives),
            timestamp: typeof input.timestamp === "number" ? input.timestamp : Date.now(),
          })
        }
        return current
      }

      case "record_failure": {
        const approach = input.approach as string
        if (approach) {
          current.failedApproaches.push({
            approach,
            reason: (input.failure_reason as string) ?? "",
            timestamp: typeof input.timestamp === "number" ? input.timestamp : Date.now(),
          })
        }
        return current
      }

      case "update_working_set": {
        const addFiles = parseStringArray(input.add_files)
        const removeFiles = new Set(parseStringArray(input.remove_files))
        const currentSet = new Set(current.workingSet)
        for (const f of addFiles) currentSet.add(f)
        for (const f of removeFiles) currentSet.delete(f)
        current.workingSet = Array.from(currentSet)
        return current
      }

      case "add_invariant": {
        const invariant = input.invariant as string
        if (invariant) {
          current.invariants.push(invariant)
        }
        return current
      }

      case "set_checkpoint": {
        const checkpoint = input.checkpoint as string
        if (checkpoint) {
          current.checkpoint = checkpoint
        }
        return current
      }

      case "get":
        // Read-only — no mutation
        return current

      default:
        log.warn("unknown state operation", { operation: op })
        return current
    }
  }

  // ─── Formatting ───────────────────────────────────────────────

  /** Maximum characters for the formatted state block. */
  const MAX_FORMAT_CHARS = 2000

  /**
   * Formats a State into a compact XML block for system prompt injection.
   *
   * Only non-empty sections are included. The output targets <1500 tokens
   * for a typical state, with a hard cap at MAX_FORMAT_CHARS.
   *
   * @param state - The state to format
   * @returns Formatted `<session-state>` XML block
   */
  export function format(state: State): string {
    const sections: string[] = []

    // Goal (always included)
    if (state.goal) {
      sections.push(`Goal: ${state.goal}`)
    }

    // Plan
    const planLines = formatPlan(state.plan)
    if (planLines.length > 0) {
      sections.push(`Plan:\n${planLines.join("\n")}`)
    }

    // Working files
    if (state.workingSet.length > 0) {
      // Shorten file paths to basenames if the full list is too long
      const files = state.workingSet
      const fileStr = files.join(", ")
      if (fileStr.length > 300) {
        // Truncate to fit — show basenames
        const basenames = files.map((f) => f.split("/").pop() ?? f)
        sections.push(`Working files: ${basenames.join(", ")}`)
      } else {
        sections.push(`Working files: ${fileStr}`)
      }
    }

    // Decisions
    if (state.decisions.length > 0) {
      const decisionLines = state.decisions.map((d) => {
        const alts = d.alternatives && d.alternatives.length > 0
          ? ` (over: ${d.alternatives.join(", ")})`
          : ""
        return `- ${d.choice} because ${d.reason}${alts}`
      })
      sections.push(`Decisions:\n${decisionLines.join("\n")}`)
    }

    // Failed approaches
    if (state.failedApproaches.length > 0) {
      const failLines = state.failedApproaches.map(
        (f) => `- Tried ${f.approach}, failed because ${f.reason}`,
      )
      sections.push(`Failed approaches:\n${failLines.join("\n")}`)
    }

    // Invariants
    if (state.invariants.length > 0) {
      const invLines = state.invariants.map((inv) => `- ${inv}`)
      sections.push(`Invariants:\n${invLines.join("\n")}`)
    }

    // Checkpoint
    if (state.checkpoint) {
      sections.push(`Checkpoint: ${state.checkpoint}`)
    }

    // Assemble the block
    let body = sections.join("\n\n")

    // Hard truncation if somehow we exceed the budget
    if (body.length > MAX_FORMAT_CHARS) {
      body = body.slice(0, MAX_FORMAT_CHARS - 3) + "..."
    }

    return `<session-state>\n${body}\n</session-state>`
  }

  /**
   * Formats plan steps with status indicators.
   *
   * @param plan - Array of plan steps
   * @returns Formatted lines like `- [done] Step description`
   */
  function formatPlan(plan: PlanStep[]): string[] {
    if (plan.length === 0) return []

    return plan.map((step) => {
      const statusTag = `[${step.status}]`
      const notes = step.notes ? ` (${step.notes})` : ""
      const deps = step.dependencies && step.dependencies.length > 0
        ? ` [after: ${step.dependencies.join(", ")}]`
        : ""
      return `- ${statusTag} ${step.step}${notes}${deps}`
    })
  }

  // ─── Parsing Helpers ──────────────────────────────────────────

  /**
   * Safely parses a raw value into an array of PlanStep objects.
   *
   * @param raw - Raw value from deserialized JSON
   * @returns Array of validated PlanStep objects
   */
  function parsePlan(raw: unknown): PlanStep[] {
    if (!Array.isArray(raw)) return []
    const result: PlanStep[] = []

    for (const item of raw) {
      if (!item || typeof item !== "object") continue
      const obj = item as Record<string, unknown>

      // Require at minimum an id and step description
      if (typeof obj.id !== "string" || typeof obj.step !== "string") continue

      const status = typeof obj.status === "string" && PLAN_STATUSES.includes(obj.status as PlanStatus)
        ? (obj.status as PlanStatus)
        : "pending"

      result.push({
        id: obj.id,
        step: obj.step,
        status,
        notes: typeof obj.notes === "string" ? obj.notes : undefined,
        dependencies: parseStringArray(obj.dependencies),
      })
    }

    return result
  }

  /**
   * Safely parses a raw value into an array of Decision objects.
   *
   * @param raw - Raw value from deserialized JSON
   * @returns Array of validated Decision objects
   */
  function parseDecisions(raw: unknown): Decision[] {
    if (!Array.isArray(raw)) return []
    const result: Decision[] = []

    for (const item of raw) {
      if (!item || typeof item !== "object") continue
      const obj = item as Record<string, unknown>

      if (typeof obj.choice !== "string" || typeof obj.reason !== "string") continue

      result.push({
        choice: obj.choice,
        reason: obj.reason,
        alternatives: parseStringArray(obj.alternatives),
        timestamp: typeof obj.timestamp === "number" ? obj.timestamp : Date.now(),
      })
    }

    return result
  }

  /**
   * Safely parses a raw value into an array of FailedApproach objects.
   *
   * @param raw - Raw value from deserialized JSON
   * @returns Array of validated FailedApproach objects
   */
  function parseFailedApproaches(raw: unknown): FailedApproach[] {
    if (!Array.isArray(raw)) return []
    const result: FailedApproach[] = []

    for (const item of raw) {
      if (!item || typeof item !== "object") continue
      const obj = item as Record<string, unknown>

      if (typeof obj.approach !== "string" || typeof obj.reason !== "string") continue

      result.push({
        approach: obj.approach,
        reason: obj.reason,
        timestamp: typeof obj.timestamp === "number" ? obj.timestamp : Date.now(),
      })
    }

    return result
  }

  /**
   * Safely coerces a raw value into a string array, filtering non-strings.
   *
   * @param raw - Raw value from deserialized JSON
   * @returns Array of strings (empty if input is not an array)
   */
  function parseStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is string => typeof item === "string")
  }
}
