import { spawn, type ChildProcess } from "child_process"
import { Log } from "../util/log"
import { Shell } from "../shell/shell"
import { WatchAnalyzer } from "./analyzer"

/**
 * Background process monitor.
 *
 * Spawns commands in the background with structured output capture,
 * ring-buffered output, and conditional triggers. Processes are scoped
 * to the current Instance and cleaned up on session end.
 */
export namespace Watch {
  const log = Log.create({ service: "watch" })

  /** Maximum lines retained in the output ring buffer. */
  const MAX_RING_LINES = 500

  /** Default process timeout: 10 minutes. */
  const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

  /** Status of a watched process. */
  export type Status = "running" | "exited" | "killed" | "timed_out"

  /** A trigger that fires on a condition. */
  export interface Trigger {
    type: "pattern" | "exit" | "timeout"
    /** Regex pattern (for pattern trigger). */
    pattern?: string
    /** Action to take when triggered. */
    action: "notify" | "stop"
    /** Timeout in seconds (for timeout trigger). */
    seconds?: number
    /** Whether this trigger has fired. */
    fired?: boolean
    /** Message when trigger fires. */
    message?: string
  }

  /** A watched background process. */
  export interface Process {
    /** Unique watch ID. */
    id: string
    /** Human-readable label. */
    label: string
    /** The command being run. */
    command: string
    /** Process ID. */
    pid: number | undefined
    /** Current status. */
    status: Status
    /** Unix timestamp when started. */
    startedAt: number
    /** Exit code (if exited). */
    exitCode: number | null
    /** Ring buffer of output lines. */
    outputRing: string[]
    /** Total lines seen (ring may have dropped earlier lines). */
    totalLines: number
    /** Lines read by last poll (cursor for new output). */
    pollCursor: number
    /** Configured triggers. */
    triggers: Trigger[]
    /** Pending trigger notifications (consumed on poll). */
    notifications: string[]
  }

  /** Internal state: process handle + metadata. */
  interface WatchEntry {
    info: Process
    proc: ChildProcess
    timeoutTimer?: ReturnType<typeof setTimeout>
  }

  let idCounter = 0

  const watches = new Map<string, WatchEntry>()

  /**
   * Start a new watched background process.
   *
   * @param command - Shell command to run
   * @param label - Human-readable description
   * @param triggers - Optional triggers for conditions
   * @param timeoutMs - Timeout in milliseconds (default 10 min)
   * @param cwd - Working directory for the command
   * @returns Watch process info
   */
  export function start(
    command: string,
    label: string,
    triggers: Trigger[] = [],
    timeoutMs?: number,
    cwd?: string,
  ): Process {
    const id = `watch_${++idCounter}`
    const shell = Shell.acceptable()
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS

    const proc = spawn(command, {
      shell,
      cwd: cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

    const info: Process = {
      id,
      label,
      command,
      pid: proc.pid,
      status: "running",
      startedAt: Date.now(),
      exitCode: null,
      outputRing: [],
      totalLines: 0,
      pollCursor: 0,
      triggers: [...triggers],
      notifications: [],
    }

    const entry: WatchEntry = { info, proc }

    // Append output to ring buffer
    const appendOutput = (chunk: Buffer) => {
      const text = chunk.toString()
      const lines = text.split("\n")
      for (const line of lines) {
        if (line === "" && lines.length > 1) continue
        info.outputRing.push(line)
        info.totalLines++
        // Trim ring buffer
        if (info.outputRing.length > MAX_RING_LINES) {
          info.outputRing.shift()
        }
        // Check pattern triggers
        checkPatternTriggers(entry, line)
      }
    }

    proc.stdout?.on("data", appendOutput)
    proc.stderr?.on("data", appendOutput)

    proc.once("exit", (code) => {
      if (info.status === "running") {
        info.status = "exited"
      }
      info.exitCode = code
      clearTimeout(entry.timeoutTimer)
      // Check exit triggers
      for (const trigger of info.triggers) {
        if (trigger.type === "exit" && !trigger.fired) {
          trigger.fired = true
          trigger.message = `Process exited with code ${code}`
          info.notifications.push(trigger.message)
        }
      }
      log.info("watch exited", { id, label, code })
    })

    proc.once("error", (err) => {
      info.status = "exited"
      info.exitCode = -1
      clearTimeout(entry.timeoutTimer)
      info.notifications.push(`Process error: ${err.message}`)
      log.error("watch error", { id, label, error: err })
    })

    // Timeout timer
    entry.timeoutTimer = setTimeout(() => {
      if (info.status === "running") {
        info.status = "timed_out"
        info.notifications.push(`Process timed out after ${Math.round(timeout / 1000)}s`)
        // Check timeout triggers
        for (const trigger of info.triggers) {
          if (trigger.type === "timeout" && !trigger.fired) {
            trigger.fired = true
            if (trigger.action === "stop") {
              killEntry(entry)
            }
          }
        }
        if (info.status === "timed_out") {
          killEntry(entry)
        }
      }
    }, timeout)
    if (entry.timeoutTimer.unref) entry.timeoutTimer.unref()

    watches.set(id, entry)
    log.info("watch started", { id, label, pid: proc.pid })

    return info
  }

  /**
   * Poll a running watch for new output and status.
   *
   * @param id - Watch ID
   * @returns Current status, new output since last poll, analysis, notifications
   */
  export function poll(id: string): {
    status: Status
    exitCode: number | null
    newLines: string[]
    analysis: WatchAnalyzer.Result
    notifications: string[]
    totalLines: number
    elapsedMs: number
  } {
    const entry = watches.get(id)
    if (!entry) throw new Error(`Watch ${id} not found`)

    const info = entry.info
    // Get lines since last poll cursor
    const ringStart = Math.max(0, info.totalLines - info.outputRing.length)
    const newStartIndex = Math.max(0, info.pollCursor - ringStart)
    const newLines = info.outputRing.slice(newStartIndex)
    info.pollCursor = info.totalLines

    // Analyze new output
    const analysis = WatchAnalyzer.analyze(newLines)

    // Drain notifications
    const notifications = [...info.notifications]
    info.notifications.length = 0

    return {
      status: info.status,
      exitCode: info.exitCode,
      newLines,
      analysis,
      notifications,
      totalLines: info.totalLines,
      elapsedMs: Date.now() - info.startedAt,
    }
  }

  /**
   * Stop a running watch.
   *
   * @param id - Watch ID
   * @returns Final status and output
   */
  export function stop(id: string): {
    status: Status
    exitCode: number | null
    output: string[]
    totalLines: number
    elapsedMs: number
  } {
    const entry = watches.get(id)
    if (!entry) throw new Error(`Watch ${id} not found`)

    if (entry.info.status === "running") {
      entry.info.status = "killed"
      killEntry(entry)
    }

    const info = entry.info
    return {
      status: info.status,
      exitCode: info.exitCode,
      output: [...info.outputRing],
      totalLines: info.totalLines,
      elapsedMs: Date.now() - info.startedAt,
    }
  }

  /** List all active watches. */
  export function list(): Process[] {
    return Array.from(watches.values()).map((e) => ({ ...e.info }))
  }

  /** Get a specific watch by ID. */
  export function get(id: string): Process | undefined {
    const entry = watches.get(id)
    return entry ? { ...entry.info } : undefined
  }

  /** Remove a completed watch from the registry. */
  export function remove(id: string): boolean {
    const entry = watches.get(id)
    if (!entry) return false
    if (entry.info.status === "running") {
      killEntry(entry)
    }
    watches.delete(id)
    return true
  }

  /** Clear all watches (for testing). */
  export function clear() {
    for (const entry of watches.values()) {
      killEntry(entry)
    }
    watches.clear()
  }

  /** Kill a watch entry's process. */
  function killEntry(entry: WatchEntry) {
    clearTimeout(entry.timeoutTimer)
    try {
      Shell.killTree(entry.proc, { exited: () => entry.info.status !== "running" })
    } catch {
      // Process may already be dead
    }
  }

  /** Check pattern triggers against a new output line. */
  function checkPatternTriggers(entry: WatchEntry, line: string) {
    for (const trigger of entry.info.triggers) {
      if (trigger.type !== "pattern" || trigger.fired || !trigger.pattern) continue
      try {
        const regex = new RegExp(trigger.pattern)
        if (regex.test(line)) {
          trigger.fired = true
          trigger.message = `Pattern matched: ${trigger.pattern}`
          entry.info.notifications.push(trigger.message)
          if (trigger.action === "stop") {
            entry.info.status = "killed"
            killEntry(entry)
          }
        }
      } catch {
        // Invalid regex — skip
      }
    }
  }
}
