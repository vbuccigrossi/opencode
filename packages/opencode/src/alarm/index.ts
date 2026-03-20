import { spawn, type ChildProcess } from "child_process"
import { Log } from "../util/log"
import { Shell } from "../shell/shell"

/**
 * Alarm/timer system for long-running job monitoring.
 *
 * Sets named timers that fire after a specified duration. When an alarm fires,
 * it optionally runs a check command (e.g. `tail -20 build.log`) and captures
 * the output. Results are stored for the agent to consume on next interaction.
 *
 * Alarms are scoped to the current process and cleaned up on session end.
 */
export namespace Alarm {
  const log = Log.create({ service: "alarm" })

  /** Status of an alarm. */
  export type Status = "pending" | "fired" | "cancelled"

  /** A scheduled alarm. */
  export interface Info {
    /** Unique alarm ID. */
    id: string
    /** Human-readable label. */
    label: string
    /** Duration in milliseconds. */
    durationMs: number
    /** Optional shell command to run when alarm fires. */
    command?: string
    /** Working directory for the command. */
    cwd?: string
    /** Unix timestamp when the alarm was set. */
    createdAt: number
    /** Unix timestamp when the alarm will fire. */
    firesAt: number
    /** Current status. */
    status: Status
    /** Output from the check command (populated after firing). */
    commandOutput?: string
    /** Exit code from the check command. */
    commandExitCode?: number | null
    /** Unix timestamp when the alarm fired. */
    firedAt?: number
    /** Whether the result has been consumed by the agent. */
    consumed: boolean
  }

  /** Internal entry with timer handle. */
  interface AlarmEntry {
    info: Info
    timer: ReturnType<typeof setTimeout>
    proc?: ChildProcess
  }

  let idCounter = 0
  const alarms = new Map<string, AlarmEntry>()

  /** Callback invoked when an alarm fires (for TUI notification). */
  let onFireCallback: ((alarm: Info) => void) | undefined

  /**
   * Register a callback for when any alarm fires.
   *
   * @param cb - Callback receiving the fired alarm info
   */
  export function onFire(cb: (alarm: Info) => void): void {
    onFireCallback = cb
  }

  /**
   * Parse a human-readable duration string into milliseconds.
   *
   * Supports formats like: "30s", "5m", "2h", "1h30m", "90m", "1.5h"
   *
   * @param input - Duration string (e.g. "3h", "30m", "90s", "1h30m")
   * @returns Duration in milliseconds
   * @throws Error if format is unrecognized
   */
  export function parseDuration(input: string): number {
    const trimmed = input.trim().toLowerCase()

    // Try compound format: 1h30m, 2h15m30s, etc.
    const compoundRegex = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/
    const match = trimmed.match(compoundRegex)
    if (match && (match[1] || match[2] || match[3])) {
      const hours = parseFloat(match[1] || "0")
      const minutes = parseFloat(match[2] || "0")
      const seconds = parseFloat(match[3] || "0")
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000)
    }

    // Try plain number (treated as minutes)
    const plainNum = parseFloat(trimmed)
    if (!isNaN(plainNum) && /^\d+(\.\d+)?$/.test(trimmed)) {
      return Math.round(plainNum * 60 * 1000)
    }

    throw new Error(
      `Invalid duration format: "${input}". Use formats like "30s", "5m", "2h", "1h30m", or a plain number (minutes).`,
    )
  }

  /**
   * Set a new alarm.
   *
   * @param label - Human-readable description
   * @param durationMs - Time until alarm fires in milliseconds
   * @param command - Optional shell command to run when alarm fires
   * @param cwd - Working directory for the command
   * @returns The created alarm info
   */
  export function set(label: string, durationMs: number, command?: string, cwd?: string): Info {
    const id = `alarm_${++idCounter}`
    const now = Date.now()

    const info: Info = {
      id,
      label,
      durationMs,
      command,
      cwd,
      createdAt: now,
      firesAt: now + durationMs,
      status: "pending",
      consumed: false,
    }

    const timer = setTimeout(() => fire(id), durationMs)
    if (timer.unref) timer.unref()

    const entry: AlarmEntry = { info, timer }
    alarms.set(id, entry)

    log.info("alarm set", { id, label, firesAt: new Date(info.firesAt).toISOString(), command })
    return info
  }

  /**
   * Fire an alarm — run its check command and store the result.
   *
   * @param id - Alarm ID to fire
   */
  async function fire(id: string): Promise<void> {
    const entry = alarms.get(id)
    if (!entry || entry.info.status !== "pending") return

    entry.info.status = "fired"
    entry.info.firedAt = Date.now()
    log.info("alarm fired", { id, label: entry.info.label })

    if (entry.info.command) {
      try {
        const output = await runCheckCommand(entry, entry.info.command, entry.info.cwd)
        entry.info.commandOutput = output.stdout
        entry.info.commandExitCode = output.exitCode
      } catch (err: any) {
        entry.info.commandOutput = `Error running check command: ${err.message}`
        entry.info.commandExitCode = -1
      }
    }

    // Notify via callback (for TUI bell/status)
    if (onFireCallback) {
      try {
        onFireCallback(entry.info)
      } catch {
        // Don't let callback errors break alarm system
      }
    }
  }

  /**
   * Run the check command for an alarm.
   *
   * @param entry - Alarm entry
   * @param command - Shell command to execute
   * @param cwd - Working directory
   * @returns stdout and exit code
   */
  function runCheckCommand(
    entry: AlarmEntry,
    command: string,
    cwd?: string,
  ): Promise<{ stdout: string; exitCode: number | null }> {
    return new Promise((resolve) => {
      const shell = Shell.acceptable()
      const timeout = 30_000 // 30s max for check command

      const proc = spawn(command, {
        shell,
        cwd: cwd ?? process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      entry.proc = proc

      const chunks: string[] = []
      proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()))
      proc.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()))

      const timer = setTimeout(() => {
        try {
          Shell.killTree(proc, { exited: () => false })
        } catch {
          // ignore
        }
        resolve({ stdout: chunks.join("") + "\n[check command timed out after 30s]", exitCode: -1 })
      }, timeout)
      if (timer.unref) timer.unref()

      proc.once("exit", (code) => {
        clearTimeout(timer)
        resolve({ stdout: chunks.join(""), exitCode: code })
      })

      proc.once("error", (err) => {
        clearTimeout(timer)
        resolve({ stdout: `Error: ${err.message}`, exitCode: -1 })
      })
    })
  }

  /**
   * Cancel a pending alarm.
   *
   * @param id - Alarm ID to cancel
   * @returns true if cancelled, false if not found or already fired
   */
  export function cancel(id: string): boolean {
    const entry = alarms.get(id)
    if (!entry) return false
    if (entry.info.status !== "pending") return false

    clearTimeout(entry.timer)
    entry.info.status = "cancelled"
    log.info("alarm cancelled", { id, label: entry.info.label })
    return true
  }

  /**
   * Get a specific alarm by ID.
   *
   * @param id - Alarm ID
   * @returns Alarm info or undefined
   */
  export function get(id: string): Info | undefined {
    const entry = alarms.get(id)
    return entry ? { ...entry.info } : undefined
  }

  /**
   * List all alarms.
   *
   * @returns Array of alarm info objects
   */
  export function list(): Info[] {
    return Array.from(alarms.values()).map((e) => ({ ...e.info }))
  }

  /**
   * Get all fired alarms that haven't been consumed yet.
   *
   * @returns Array of unconsumed fired alarm info objects
   */
  export function pending(): Info[] {
    return Array.from(alarms.values())
      .filter((e) => e.info.status === "fired" && !e.info.consumed)
      .map((e) => ({ ...e.info }))
  }

  /**
   * Mark an alarm's result as consumed by the agent.
   *
   * @param id - Alarm ID
   * @returns true if marked, false if not found
   */
  export function consume(id: string): boolean {
    const entry = alarms.get(id)
    if (!entry) return false
    entry.info.consumed = true
    return true
  }

  /**
   * Remove a completed or cancelled alarm from the registry.
   *
   * @param id - Alarm ID
   * @returns true if removed
   */
  export function remove(id: string): boolean {
    const entry = alarms.get(id)
    if (!entry) return false
    if (entry.info.status === "pending") {
      clearTimeout(entry.timer)
    }
    alarms.delete(id)
    return true
  }

  /**
   * Clear all alarms (for cleanup or testing).
   */
  export function clear(): void {
    for (const entry of alarms.values()) {
      clearTimeout(entry.timer)
      if (entry.proc) {
        try {
          Shell.killTree(entry.proc, { exited: () => false })
        } catch {
          // ignore
        }
      }
    }
    alarms.clear()
    idCounter = 0
  }

  /**
   * Format remaining time as human-readable string.
   *
   * @param ms - Milliseconds remaining
   * @returns Formatted string like "2h 15m", "5m 30s", etc.
   */
  export function formatRemaining(ms: number): string {
    if (ms <= 0) return "now"
    const hours = Math.floor(ms / 3_600_000)
    const minutes = Math.floor((ms % 3_600_000) / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)

    const parts: string[] = []
    if (hours > 0) parts.push(`${hours}h`)
    if (minutes > 0) parts.push(`${minutes}m`)
    if (seconds > 0 && hours === 0) parts.push(`${seconds}s`)
    return parts.join(" ") || "0s"
  }
}
