import z from "zod"
import { Tool } from "./tool"
import { Schedule } from "../schedule"
import { Scheduler } from "../schedule/scheduler"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

/**
 * Schedule tool — manage scheduled tasks (cron-based recurring sessions).
 *
 * Provides CRUD operations plus trigger/status for the task scheduler.
 */
export const ScheduleTool = Tool.define("schedule", async () => ({
  description: `Manage scheduled tasks that run on a cron schedule.

Operations:
- list: List all scheduled tasks for the current project.
- create: Create a new scheduled task with a cron expression and prompt.
- update: Update an existing task (name, cron, prompt, enabled, delivery).
- delete: Remove a scheduled task.
- trigger: Immediately trigger a scheduled task (runs it now regardless of schedule).
- get: Get details of a specific task by ID.

Cron expressions use standard 5-field format (minute hour day month weekday).
Examples: "0 9 * * *" (daily 9am), "*/30 * * * *" (every 30 min), "0 0 * * 1" (Monday midnight).

Delivery types:
- session: Result stays in session history (default).
- file: Write result to a file path.
- webhook: POST result to a URL.`,
  parameters: z.object({
    operation: z
      .enum(["list", "create", "update", "delete", "trigger", "get"])
      .describe("The schedule operation to perform"),
    id: z.string().optional().describe("Task ID (for get, update, delete, trigger)"),
    name: z.string().optional().describe("Task name (for create, update)"),
    cron: z.string().optional().describe("Cron expression (for create, update)"),
    prompt: z.string().optional().describe("Prompt to execute (for create, update)"),
    enabled: z.boolean().optional().describe("Enable/disable task (for update)"),
    agent: z.string().optional().describe("Agent name override (for create, update)"),
    model: z.string().optional().describe("Model override (for create, update)"),
    delivery_type: z
      .enum(["session", "file", "webhook"])
      .optional()
      .describe("Delivery type (for create, update)"),
    delivery_path: z.string().optional().describe("File path for file delivery"),
    delivery_url: z.string().optional().describe("URL for webhook delivery"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "list":
        return scheduleList()
      case "create":
        return scheduleCreate(params)
      case "update":
        return scheduleUpdate(params)
      case "delete":
        return scheduleDelete(params)
      case "trigger":
        return scheduleTrigger(params)
      case "get":
        return scheduleGet(params)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.schedule" })

function formatTask(task: Schedule.Info): string {
  const status = task.enabled ? "enabled" : "disabled"
  const lastRun = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : "never"
  const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "none"
  const lines = [
    `ID: ${task.id}`,
    `Name: ${task.name}`,
    `Cron: ${task.cron} (${Schedule.describeCron(task.cron)})`,
    `Status: ${status}`,
    `Prompt: ${task.prompt.length > 100 ? task.prompt.slice(0, 100) + "..." : task.prompt}`,
    `Delivery: ${typeof task.delivery === "object" ? task.delivery.type : "session"}`,
    `Last run: ${lastRun}${task.lastStatus ? ` (${task.lastStatus})` : ""}`,
    `Next run: ${nextRun}`,
  ]
  if (task.agent) lines.push(`Agent: ${task.agent}`)
  if (task.model) lines.push(`Model: ${task.model}`)
  if (task.lastError) lines.push(`Last error: ${task.lastError}`)
  return lines.join("\n")
}

function scheduleList(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const tasks = Schedule.list(Instance.project.id)
  if (tasks.length === 0) {
    return Promise.resolve({
      title: "schedule: no tasks",
      metadata: { count: 0 },
      output: "No scheduled tasks for this project.",
    })
  }

  const output = tasks.map(formatTask).join("\n\n---\n\n")
  return Promise.resolve({
    title: `schedule: ${tasks.length} task(s)`,
    metadata: { count: tasks.length, ids: tasks.map((t) => t.id) },
    output,
  })
}

function buildDelivery(params: {
  delivery_type?: string
  delivery_path?: string
  delivery_url?: string
}): Schedule.DeliveryConfig | undefined {
  if (!params.delivery_type) return undefined
  switch (params.delivery_type) {
    case "file":
      if (!params.delivery_path) throw new Error("delivery_path required for file delivery")
      return { type: "file", path: params.delivery_path }
    case "webhook":
      if (!params.delivery_url) throw new Error("delivery_url required for webhook delivery")
      return { type: "webhook", url: params.delivery_url }
    case "session":
    default:
      return { type: "session" }
  }
}

function scheduleCreate(params: {
  name?: string
  cron?: string
  prompt?: string
  agent?: string
  model?: string
  delivery_type?: string
  delivery_path?: string
  delivery_url?: string
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.name) throw new Error("name is required for create")
  if (!params.cron) throw new Error("cron is required for create")
  if (!params.prompt) throw new Error("prompt is required for create")

  const cronErr = Schedule.validateCron(params.cron)
  if (cronErr) throw new Error(`Invalid cron expression: ${cronErr}`)

  const delivery = buildDelivery(params)
  const task = Schedule.create({
    name: params.name,
    cron: params.cron,
    prompt: params.prompt,
    agent: params.agent,
    model: params.model,
    delivery,
  })

  return Promise.resolve({
    title: `schedule: created "${task.name}"`,
    metadata: { id: task.id, name: task.name },
    output: `Task created successfully.\n\n${formatTask(task)}`,
  })
}

function scheduleUpdate(params: {
  id?: string
  name?: string
  cron?: string
  prompt?: string
  enabled?: boolean
  agent?: string
  model?: string
  delivery_type?: string
  delivery_path?: string
  delivery_url?: string
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for update")

  const existing = Schedule.get(params.id)
  if (!existing) throw new Error(`Task ${params.id} not found`)

  if (params.cron) {
    const cronErr = Schedule.validateCron(params.cron)
    if (cronErr) throw new Error(`Invalid cron expression: ${cronErr}`)
  }

  const delivery = buildDelivery(params)
  const task = Schedule.update({
    id: params.id,
    name: params.name,
    cron: params.cron,
    prompt: params.prompt,
    enabled: params.enabled,
    agent: params.agent,
    model: params.model,
    delivery,
  })

  return Promise.resolve({
    title: `schedule: updated "${task.name}"`,
    metadata: { id: task.id },
    output: `Task updated.\n\n${formatTask(task)}`,
  })
}

function scheduleDelete(params: { id?: string }): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for delete")

  const existing = Schedule.get(params.id)
  if (!existing) throw new Error(`Task ${params.id} not found`)

  Schedule.remove(params.id)
  return Promise.resolve({
    title: `schedule: deleted "${existing.name}"`,
    metadata: { id: params.id },
    output: `Deleted task "${existing.name}" (${params.id}).`,
  })
}

async function scheduleTrigger(params: { id?: string }): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for trigger")

  const existing = Schedule.get(params.id)
  if (!existing) throw new Error(`Task ${params.id} not found`)

  const result = await Scheduler.triggerNow(params.id)
  if (!result.ok) {
    return {
      title: `schedule: trigger failed "${existing.name}"`,
      metadata: { id: params.id, error: result.error },
      output: `Failed to trigger "${existing.name}": ${result.error}`,
    }
  }

  return {
    title: `schedule: triggered "${existing.name}"`,
    metadata: { id: params.id },
    output: `Triggered task "${existing.name}" (${params.id}). Execution started.`,
  }
}

function scheduleGet(params: { id?: string }): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for get")

  const task = Schedule.get(params.id)
  if (!task) {
    return Promise.resolve({
      title: "schedule: not found",
      metadata: { id: params.id },
      output: `Task ${params.id} not found.`,
    })
  }

  return Promise.resolve({
    title: `schedule: ${task.name}`,
    metadata: { id: task.id, name: task.name },
    output: formatTask(task),
  })
}
