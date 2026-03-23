import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import { spawn } from "child_process"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "daemon" })

/**
 * Daemon manager for the Cortex background server.
 *
 * Manages a long-running `opencode serve` process that provides:
 * - Task scheduler (cron-based)
 * - Event journal and SSE
 * - Device sync and push notifications
 * - MCP server for external clients
 *
 * PID and port are stored in ~/.local/state/cortex/daemon.json
 */
export namespace Daemon {
  export interface Info {
    pid: number
    port: number
    hostname: string
    startedAt: number
    /** The opencode binary that started this daemon. */
    bin: string
  }

  const STATE_FILE = path.join(Global.Path.state, "daemon.json")

  /** Maximum daemon.log size before rotation (5 MB). */
  const MAX_LOG_BYTES = 5 * 1024 * 1024

  /**
   * Rotate daemon.log if it exceeds MAX_LOG_BYTES.
   * Keeps one backup (.1). Runs synchronously before spawn.
   */
  function rotateLog(logFile: string): void {
    try {
      const stat = fs.statSync(logFile)
      if (stat.size > MAX_LOG_BYTES) {
        const backup = logFile + ".1"
        try {
          fs.unlinkSync(backup)
        } catch {}
        fs.renameSync(logFile, backup)
        log.info("daemon log rotated", { size: stat.size, backup })
      }
    } catch {
      // File doesn't exist yet — nothing to rotate
    }
  }

  /** Read the daemon state file. Returns undefined if not found or invalid. */
  export function read(): Info | undefined {
    try {
      const raw = fs.readFileSync(STATE_FILE, "utf-8")
      return JSON.parse(raw) as Info
    } catch {
      return undefined
    }
  }

  /** Write daemon state. */
  export function write(info: Info): void {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(info, null, 2))
  }

  /** Remove daemon state file. */
  export function clear(): void {
    try {
      fs.unlinkSync(STATE_FILE)
    } catch {}
  }

  /** Check if a process with the given PID is alive. */
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Check if the daemon's HTTP server is responding. */
  async function isResponding(hostname: string, port: number): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      const res = await fetch(`http://${hostname}:${port}/health`, {
        signal: controller.signal,
      }).catch(() => null)
      clearTimeout(timeout)
      return res?.ok === true
    } catch {
      return false
    }
  }

  /** Get daemon status. */
  export async function status(): Promise<
    { running: true; info: Info } | { running: false; reason: string }
  > {
    const info = read()
    if (!info) return { running: false, reason: "no daemon state file" }
    if (!isAlive(info.pid)) {
      clear()
      return { running: false, reason: "process not found (stale PID file)" }
    }
    const responding = await isResponding(info.hostname, info.port)
    if (!responding) {
      return { running: false, reason: "process alive but not responding" }
    }
    return { running: true, info }
  }

  /**
   * Start the daemon. Spawns `opencode serve` as a detached background process.
   * Returns the daemon info once it's confirmed responsive.
   */
  export async function start(opts?: {
    port?: number
    hostname?: string
  }): Promise<Info> {
    // Check if already running
    const current = await status()
    if (current.running) {
      log.info("daemon already running", { pid: current.info.pid, port: current.info.port })
      return current.info
    }

    const hostname = opts?.hostname ?? "127.0.0.1"
    // Use port 0 to let the OS pick an available port
    const port = opts?.port ?? 0

    // Find the opencode binary
    const bin = process.argv[0] === "bun" || process.argv[0]?.endsWith("/bun")
      ? process.argv.slice(0, 2).join(" ")
      : process.execPath

    const args = ["serve", "--hostname", hostname]
    if (port !== 0) args.push("--port", String(port))

    // Build the spawn command
    // If running via bun (dev mode), we need: bun run src/index.ts serve ...
    // If running as compiled binary: opencode serve ...
    let spawnCmd: string
    let spawnArgs: string[]

    if (process.argv[1] && (process.argv[1].endsWith(".ts") || process.argv[1].endsWith(".js"))) {
      // Dev mode: bun run <script> serve ...
      spawnCmd = process.execPath
      spawnArgs = [process.argv[1], ...args]
    } else {
      // Compiled binary
      spawnCmd = process.execPath
      spawnArgs = args
    }

    // Spawn detached process
    const logFile = path.join(Global.Path.log, "daemon.log")
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    rotateLog(logFile)

    const out = fs.openSync(logFile, "a")
    const err = fs.openSync(logFile, "a")

    const child = spawn(spawnCmd, spawnArgs, {
      detached: true,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        CORTEX_DAEMON: "1",
      },
    })

    child.unref()
    fs.closeSync(out)
    fs.closeSync(err)

    const pid = child.pid
    if (!pid) {
      throw new Error("Failed to spawn daemon process")
    }

    log.info("daemon spawned", { pid, cmd: spawnCmd, args: spawnArgs })

    // Wait for the daemon to start responding
    // The daemon writes its state file once it's listening, so we poll for it
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))

      const info = read()
      if (info && info.pid === pid) {
        const responding = await isResponding(info.hostname, info.port)
        if (responding) {
          log.info("daemon ready", { pid: info.pid, port: info.port })

          // Start watchdog to auto-restart if daemon crashes
          startWatchdog(opts)
          return info
        }
      }

      // Check if process died
      if (!isAlive(pid)) {
        clear()
        throw new Error(`Daemon process ${pid} exited unexpectedly. Check ${logFile}`)
      }
    }

    throw new Error(`Daemon failed to become responsive within 15s. Check ${logFile}`)
  }

  /** Stop the daemon gracefully. */
  export async function stop(): Promise<boolean> {
    stopWatchdog()

    const info = read()
    if (!info) return false

    if (!isAlive(info.pid)) {
      clear()
      return false
    }

    // Send SIGTERM for graceful shutdown
    try {
      process.kill(info.pid, "SIGTERM")
    } catch {
      clear()
      return false
    }

    // Wait for process to exit
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      if (!isAlive(info.pid)) {
        clear()
        return true
      }
    }

    // Force kill if still alive
    try {
      process.kill(info.pid, "SIGKILL")
    } catch {}
    clear()
    return true
  }

  /** Get the URL for the running daemon. */
  export function url(info: Info): string {
    return `http://${info.hostname}:${info.port}`
  }

  // --- Watchdog ---
  // Monitors the daemon process and restarts it if it exits unexpectedly.
  // Runs in the parent process (TUI or CLI) that called Daemon.start().

  let watchdogTimer: ReturnType<typeof setInterval> | undefined
  /** Maximum consecutive restart attempts before giving up. */
  const MAX_RESTARTS = 3
  /** Minimum uptime (ms) to reset the restart counter — prevents crash loops. */
  const MIN_UPTIME_MS = 30_000
  const WATCHDOG_POLL_MS = 10_000
  let restartCount = 0
  let lastStartTime = 0

  /**
   * Start the watchdog polling loop. Checks if the daemon PID is still alive
   * every WATCHDOG_POLL_MS. If the daemon exited (not via Daemon.stop()),
   * attempts to restart it up to MAX_RESTARTS times.
   */
  function startWatchdog(opts?: { port?: number; hostname?: string }): void {
    stopWatchdog()
    restartCount = 0
    lastStartTime = Date.now()

    watchdogTimer = setInterval(async () => {
      const info = read()
      if (!info) return // No state file — daemon was stopped intentionally

      if (isAlive(info.pid)) {
        // Still running — reset counter if it's been up long enough
        if (Date.now() - lastStartTime > MIN_UPTIME_MS) {
          restartCount = 0
        }
        return
      }

      // Daemon is dead — attempt restart
      if (restartCount >= MAX_RESTARTS) {
        log.error("daemon watchdog: max restarts reached, giving up", {
          restarts: restartCount,
        })
        stopWatchdog()
        clear()
        return
      }

      restartCount++
      log.warn("daemon watchdog: daemon exited unexpectedly, restarting", {
        attempt: restartCount,
        maxAttempts: MAX_RESTARTS,
      })

      clear()
      try {
        lastStartTime = Date.now()
        await start(opts)
        log.info("daemon watchdog: restart successful", { attempt: restartCount })
      } catch (err) {
        log.error("daemon watchdog: restart failed", {
          attempt: restartCount,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }, WATCHDOG_POLL_MS)

    // Don't prevent process exit
    if (watchdogTimer.unref) watchdogTimer.unref()
  }

  /** Stop the watchdog polling loop. */
  function stopWatchdog(): void {
    if (!watchdogTimer) return
    clearInterval(watchdogTimer)
    watchdogTimer = undefined
  }
}
