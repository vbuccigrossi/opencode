import z from "zod"
import { Tool } from "./tool"
import { Watch } from "../watch"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

/**
 * Watch tool — monitors background processes with structured output analysis.
 *
 * Spawns commands in the background and provides intelligent polling
 * with error detection, progress tracking, and conditional triggers.
 */
export const WatchTool = Tool.define("watch", async () => ({
  description: `Monitor long-running background processes with intelligent output analysis.

Operations:
- start: Spawn a command in the background with a label and optional triggers
- poll: Check status and new output of a running watch (with analysis)
- stop: Kill a running watch and return final output
- list: Show all active watches with their status
- wait: Poll until a watch exits or a pattern appears

Use this tool for:
- Monitoring builds, deploys, or test suites without blocking
- Watching a dev server while making edits
- Running long commands and checking back later
- Setting triggers to notify when a build completes or fails

Triggers (optional on start):
- pattern: Fire when a regex matches output (action: "notify" or "stop")
- exit: Fire when process exits (action: "notify")
- timeout: Fire after N seconds (action: "notify" or "stop")`,
  parameters: z.object({
    operation: z
      .enum(["start", "poll", "stop", "list", "wait"])
      .describe("The watch operation to perform"),
    command: z.string().optional().describe("Shell command to run (required for start)"),
    label: z.string().optional().describe("Human-readable label for the watch (required for start)"),
    watch_id: z.string().optional().describe("Watch ID (required for poll, stop, wait)"),
    triggers: z
      .array(
        z.object({
          type: z.enum(["pattern", "exit", "timeout"]).describe("Trigger type"),
          pattern: z.string().optional().describe("Regex pattern (for pattern trigger)"),
          action: z.enum(["notify", "stop"]).describe("Action when triggered"),
          seconds: z.number().optional().describe("Timeout in seconds (for timeout trigger)"),
        }),
      )
      .optional()
      .describe("Triggers to configure (for start operation)"),
    timeout: z.number().optional().describe("Timeout in seconds (for start operation, default 600)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "start":
        return watchStart(params, ctx)
      case "poll":
        return watchPoll(params.watch_id)
      case "stop":
        return watchStop(params.watch_id)
      case "list":
        return watchList()
      case "wait":
        return await watchWait(params.watch_id, ctx)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.watch" })

/** Start a new background watch. */
function watchStart(
  params: {
    command?: string
    label?: string
    triggers?: Watch.Trigger[]
    timeout?: number
  },
  ctx: Tool.Context,
): { title: string; metadata: Record<string, any>; output: string } {
  if (!params.command) throw new Error("command parameter is required for start operation")
  if (!params.label) throw new Error("label parameter is required for start operation")

  // Ask permission for the bash command
  // Note: The watch tool inherits bash permissions since it spawns shell commands

  const timeoutMs = params.timeout ? params.timeout * 1000 : undefined
  const triggers = params.triggers ?? []

  const info = Watch.start(params.command, params.label, triggers, timeoutMs, Instance.directory)

  const triggerDesc = triggers.length > 0
    ? `\nTriggers: ${triggers.map((t) => `${t.type}(${t.pattern ?? t.seconds ?? ""}):${t.action}`).join(", ")}`
    : ""

  return {
    title: `watch: started ${params.label}`,
    metadata: {
      watchID: info.id,
      pid: info.pid,
      label: info.label,
      command: info.command,
    },
    output: `Started watch "${info.label}" (ID: ${info.id}, PID: ${info.pid}).\nCommand: ${info.command}${triggerDesc}\n\nUse poll with watch_id="${info.id}" to check status and output.`,
  }
}

/** Poll a running watch. */
function watchPoll(
  watchID?: string,
): { title: string; metadata: Record<string, any>; output: string } {
  if (!watchID) throw new Error("watch_id parameter is required for poll operation")

  const result = Watch.poll(watchID)
  const sections: string[] = []

  sections.push(`Status: ${result.status}${result.exitCode !== null ? ` (exit code: ${result.exitCode})` : ""}`)
  sections.push(`Elapsed: ${formatMs(result.elapsedMs)}`)
  sections.push(`Total lines: ${result.totalLines}`)

  if (result.notifications.length > 0) {
    sections.push(`\nNotifications:\n${result.notifications.map((n) => `  ! ${n}`).join("\n")}`)
  }

  sections.push(`\nAnalysis: ${result.analysis.summary}`)

  if (result.analysis.errors.length > 0) {
    sections.push(`\nErrors (${result.analysis.errors.length}):`)
    for (const err of result.analysis.errors.slice(0, 10)) {
      sections.push(`  ${err.source}: ${err.text.trim().slice(0, 200)}`)
    }
    if (result.analysis.errors.length > 10) {
      sections.push(`  ... and ${result.analysis.errors.length - 10} more`)
    }
  }

  if (result.analysis.warnings.length > 0) {
    sections.push(`\nWarnings (${result.analysis.warnings.length}):`)
    for (const w of result.analysis.warnings.slice(0, 5)) {
      sections.push(`  ${w.source}: ${w.text.trim().slice(0, 200)}`)
    }
  }

  if (result.analysis.suggestedAction) {
    sections.push(`\nSuggested action: ${result.analysis.suggestedAction}`)
  }

  if (result.newLines.length > 0) {
    const preview = result.newLines.slice(-20)
    const skipped = result.newLines.length - preview.length
    sections.push(`\nNew output (${result.newLines.length} lines${skipped > 0 ? `, showing last 20` : ""}):`)
    for (const line of preview) {
      sections.push(`  ${line}`)
    }
  } else {
    sections.push("\nNo new output since last poll.")
  }

  return {
    title: `watch: poll ${watchID}`,
    metadata: {
      watchID,
      status: result.status,
      exitCode: result.exitCode,
      newLines: result.newLines.length,
      errors: result.analysis.errors.length,
      warnings: result.analysis.warnings.length,
      completion: result.analysis.completion,
      suggestedAction: result.analysis.suggestedAction,
    },
    output: sections.join("\n"),
  }
}

/** Stop a running watch. */
function watchStop(
  watchID?: string,
): { title: string; metadata: Record<string, any>; output: string } {
  if (!watchID) throw new Error("watch_id parameter is required for stop operation")

  const result = Watch.stop(watchID)

  const lastLines = result.output.slice(-10)
  const outputPreview = lastLines.length > 0
    ? `\nLast ${lastLines.length} line(s):\n${lastLines.map((l) => `  ${l}`).join("\n")}`
    : ""

  return {
    title: `watch: stopped ${watchID}`,
    metadata: {
      watchID,
      status: result.status,
      exitCode: result.exitCode,
      totalLines: result.totalLines,
      elapsedMs: result.elapsedMs,
    },
    output: `Stopped watch ${watchID}. Status: ${result.status}, exit code: ${result.exitCode}, total lines: ${result.totalLines}, elapsed: ${formatMs(result.elapsedMs)}.${outputPreview}`,
  }
}

/** List all watches. */
function watchList(): { title: string; metadata: Record<string, any>; output: string } {
  const watches = Watch.list()

  if (watches.length === 0) {
    return {
      title: "watch: list",
      metadata: { count: 0 },
      output: "No active watches.",
    }
  }

  const lines = watches.map((w) => {
    const elapsed = formatMs(Date.now() - w.startedAt)
    const exit = w.exitCode !== null ? ` (exit: ${w.exitCode})` : ""
    return `${w.id} [${w.status}${exit}] "${w.label}" — ${elapsed}, ${w.totalLines} lines`
  })

  return {
    title: "watch: list",
    metadata: { count: watches.length },
    output: `${watches.length} watch(es):\n\n${lines.join("\n")}`,
  }
}

/** Wait for a watch to complete or timeout. */
async function watchWait(
  watchID?: string,
  ctx?: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!watchID) throw new Error("watch_id parameter is required for wait operation")

  const maxWaitMs = 120_000 // 2 minute max wait
  const pollIntervalMs = 1000
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    const info = Watch.get(watchID)
    if (!info) throw new Error(`Watch ${watchID} not found`)
    if (info.status !== "running") {
      // Process completed — return final poll
      return watchPoll(watchID)
    }

    // Check if agent was aborted
    if (ctx?.abort?.aborted) {
      return {
        title: `watch: wait aborted ${watchID}`,
        metadata: { watchID, status: "running", aborted: true },
        output: `Wait aborted. Watch ${watchID} is still running. Use poll to check later.`,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  return {
    title: `watch: wait timeout ${watchID}`,
    metadata: { watchID, status: "running", waitTimeout: true },
    output: `Wait timed out after ${formatMs(maxWaitMs)}. Watch ${watchID} is still running. Use poll to check status.`,
  }
}

/** Format milliseconds as human-readable string. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}
