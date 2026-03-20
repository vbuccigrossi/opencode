import z from "zod"
import { Tool } from "./tool"
import { Alarm } from "../alarm"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

/**
 * Alarm tool — set timers for long-running jobs with optional check commands.
 *
 * When a task will take a long time (builds, deployments, test suites),
 * set an alarm to fire after the expected duration. The alarm can optionally
 * run a check command when it fires to capture the job's current state.
 */
export const AlarmTool = Tool.define("alarm", async () => ({
  description: `Set timers and alarms for long-running jobs with optional check commands.

Operations:
- set: Create a new alarm with a duration and optional check command
- list: Show all alarms (pending, fired, cancelled)
- check: Get results from fired alarms
- cancel: Cancel a pending alarm
- remove: Remove a completed alarm from the list

Use this tool when:
- A build, deploy, or test suite will take a long time
- You want to be reminded to check on a running process
- You need to schedule a check command to run after a delay
- You want to monitor job completion without blocking

Duration formats: "30s", "5m", "2h", "1h30m", or plain number (minutes)

Examples:
- Set alarm for a 3-hour build: set with duration "3h", command "tail -20 build.log"
- Set alarm for deploy: set with duration "15m", command "curl -s http://localhost:3000/health"
- Check if any alarms have fired: check (returns unconsumed alarm results)`,
  parameters: z.object({
    operation: z
      .enum(["set", "list", "check", "cancel", "remove"])
      .describe("The alarm operation to perform"),
    label: z.string().optional().describe("Human-readable label for the alarm (required for set)"),
    duration: z
      .string()
      .optional()
      .describe('Duration until alarm fires (required for set). Formats: "30s", "5m", "2h", "1h30m"'),
    command: z
      .string()
      .optional()
      .describe("Shell command to run when alarm fires (optional for set). E.g. 'tail -20 build.log'"),
    alarm_id: z.string().optional().describe("Alarm ID (required for cancel, remove)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "set":
        return alarmSet(params)
      case "list":
        return alarmList()
      case "check":
        return alarmCheck()
      case "cancel":
        return alarmCancel(params.alarm_id)
      case "remove":
        return alarmRemove(params.alarm_id)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.alarm" })

/**
 * Set a new alarm.
 *
 * @param params - Operation parameters including label, duration, optional command
 * @returns Tool result with alarm details
 */
function alarmSet(params: {
  label?: string
  duration?: string
  command?: string
}): { title: string; metadata: Record<string, any>; output: string } {
  if (!params.label) throw new Error("label parameter is required for set operation")
  if (!params.duration) throw new Error("duration parameter is required for set operation")

  const durationMs = Alarm.parseDuration(params.duration)
  const info = Alarm.set(params.label, durationMs, params.command, Instance.directory)

  const firesAt = new Date(info.firesAt)
  const remaining = Alarm.formatRemaining(info.firesAt - Date.now())

  const cmdNote = params.command
    ? `\nCheck command: ${params.command} (will run when alarm fires)`
    : "\nNo check command set — alarm will fire as a reminder only."

  return {
    title: `alarm: set "${params.label}" (${remaining})`,
    metadata: {
      alarmID: info.id,
      label: info.label,
      firesAt: firesAt.toISOString(),
      durationMs,
      command: params.command,
    },
    output: `Alarm "${info.label}" set (ID: ${info.id}).\nFires at: ${firesAt.toLocaleTimeString()} (in ${remaining})${cmdNote}\n\nUse alarm check operation to see results after it fires.`,
  }
}

/**
 * List all alarms with their status and timing info.
 *
 * @returns Tool result with alarm listing
 */
function alarmList(): { title: string; metadata: Record<string, any>; output: string } {
  const all = Alarm.list()

  if (all.length === 0) {
    return {
      title: "alarm: list",
      metadata: { count: 0 },
      output: "No alarms set.",
    }
  }

  const lines = all.map((a) => {
    const now = Date.now()
    let timing: string
    if (a.status === "pending") {
      timing = `fires in ${Alarm.formatRemaining(a.firesAt - now)}`
    } else if (a.status === "fired") {
      timing = `fired ${Alarm.formatRemaining(now - (a.firedAt ?? now))} ago`
    } else {
      timing = "cancelled"
    }

    const consumed = a.status === "fired" && a.consumed ? " (consumed)" : ""
    const cmd = a.command ? ` — cmd: ${a.command}` : ""
    return `  ${a.id} [${a.status}${consumed}] "${a.label}" — ${timing}${cmd}`
  })

  return {
    title: "alarm: list",
    metadata: {
      count: all.length,
      pending: all.filter((a) => a.status === "pending").length,
      fired: all.filter((a) => a.status === "fired").length,
    },
    output: `${all.length} alarm(s):\n\n${lines.join("\n")}`,
  }
}

/**
 * Check for fired alarms and return their results.
 * Marks checked alarms as consumed.
 *
 * @returns Tool result with fired alarm details
 */
function alarmCheck(): { title: string; metadata: Record<string, any>; output: string } {
  const fired = Alarm.pending()

  if (fired.length === 0) {
    // Also show pending alarms as context
    const pendingAlarms = Alarm.list().filter((a) => a.status === "pending")
    const pendingNote =
      pendingAlarms.length > 0
        ? `\n\n${pendingAlarms.length} alarm(s) still pending:\n${pendingAlarms
            .map((a) => `  ${a.id} "${a.label}" — fires in ${Alarm.formatRemaining(a.firesAt - Date.now())}`)
            .join("\n")}`
        : ""

    return {
      title: "alarm: check",
      metadata: { fired: 0, pending: pendingAlarms.length },
      output: `No alarms have fired since last check.${pendingNote}`,
    }
  }

  const sections: string[] = []
  sections.push(`${fired.length} alarm(s) fired:\n`)

  for (const alarm of fired) {
    sections.push(`--- ${alarm.id}: "${alarm.label}" ---`)
    sections.push(`Fired at: ${new Date(alarm.firedAt!).toLocaleTimeString()}`)

    if (alarm.command) {
      sections.push(`Check command: ${alarm.command}`)
      sections.push(`Exit code: ${alarm.commandExitCode}`)
      if (alarm.commandOutput) {
        const output = alarm.commandOutput.trim()
        const lines = output.split("\n")
        if (lines.length > 50) {
          sections.push(`Output (last 50 of ${lines.length} lines):`)
          sections.push(lines.slice(-50).join("\n"))
        } else {
          sections.push(`Output:\n${output}`)
        }
      } else {
        sections.push("No output from check command.")
      }
    } else {
      sections.push("(reminder only — no check command)")
    }

    // Mark as consumed
    Alarm.consume(alarm.id)
    sections.push("")
  }

  return {
    title: `alarm: ${fired.length} fired`,
    metadata: {
      fired: fired.length,
      alarms: fired.map((a) => ({
        id: a.id,
        label: a.label,
        exitCode: a.commandExitCode,
      })),
    },
    output: sections.join("\n"),
  }
}

/**
 * Cancel a pending alarm.
 *
 * @param alarmID - ID of alarm to cancel
 * @returns Tool result confirming cancellation
 */
function alarmCancel(alarmID?: string): { title: string; metadata: Record<string, any>; output: string } {
  if (!alarmID) throw new Error("alarm_id parameter is required for cancel operation")

  const alarm = Alarm.get(alarmID)
  if (!alarm) throw new Error(`Alarm ${alarmID} not found`)

  if (alarm.status !== "pending") {
    return {
      title: `alarm: cannot cancel ${alarmID}`,
      metadata: { alarmID, status: alarm.status },
      output: `Cannot cancel alarm ${alarmID} — status is "${alarm.status}" (only pending alarms can be cancelled).`,
    }
  }

  Alarm.cancel(alarmID)
  return {
    title: `alarm: cancelled ${alarmID}`,
    metadata: { alarmID, label: alarm.label },
    output: `Alarm "${alarm.label}" (${alarmID}) cancelled.`,
  }
}

/**
 * Remove an alarm from the list.
 *
 * @param alarmID - ID of alarm to remove
 * @returns Tool result confirming removal
 */
function alarmRemove(alarmID?: string): { title: string; metadata: Record<string, any>; output: string } {
  if (!alarmID) throw new Error("alarm_id parameter is required for remove operation")

  const removed = Alarm.remove(alarmID)
  if (!removed) throw new Error(`Alarm ${alarmID} not found`)

  return {
    title: `alarm: removed ${alarmID}`,
    metadata: { alarmID },
    output: `Alarm ${alarmID} removed.`,
  }
}
