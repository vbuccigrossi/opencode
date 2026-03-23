import { Schedule } from "./index"
import { Delivery } from "./delivery"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { InstanceBootstrap } from "../project/bootstrap"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { MessageV2 } from "../session/message-v2"
import { Database } from "../storage/db"
import { MessageTable } from "../session/session.sql"
import { eq } from "drizzle-orm"
import { ProviderID, ModelID } from "../provider/schema"

const log = Log.create({ service: "scheduler" })

/**
 * The Scheduler daemon polls the database every POLL_INTERVAL_MS for tasks
 * whose next_run_at is in the past, executes them in isolated sessions, and
 * delivers the results according to each task's delivery configuration.
 *
 * Designed to run inside `cortex serve`. Start with Scheduler.start(),
 * stop with Scheduler.stop(). Survives restarts by reading persisted
 * next_run_at from the database.
 */
export namespace Scheduler {
  const POLL_INTERVAL_MS = 30_000
  /** Maximum time a single task execution can take before being aborted. */
  const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
  /** Maximum time to wait for in-flight tasks during shutdown. */
  const DRAIN_TIMEOUT_MS = 15_000
  let timer: ReturnType<typeof setInterval> | undefined
  const running = new Map<string, Promise<void>>()

  /** Start the polling loop. Call once at server startup. */
  export function start(): void {
    if (timer) return
    log.info("scheduler started", { pollIntervalMs: POLL_INTERVAL_MS })

    // Run first tick immediately to catch up missed tasks
    tick().catch((err) => log.error("scheduler tick error", { error: err }))

    timer = setInterval(() => {
      tick().catch((err) => log.error("scheduler tick error", { error: err }))
    }, POLL_INTERVAL_MS)

    // Don't prevent process exit
    if (timer.unref) timer.unref()
  }

  /**
   * Stop the polling loop and wait for in-flight tasks to complete.
   * Returns a promise that resolves when all running tasks finish
   * or DRAIN_TIMEOUT_MS elapses (whichever comes first).
   */
  export async function stop(): Promise<void> {
    if (!timer) return
    clearInterval(timer)
    timer = undefined

    if (running.size === 0) {
      log.info("scheduler stopped")
      return
    }

    log.info("scheduler stopping, draining in-flight tasks", { count: running.size })

    const drain = Promise.allSettled([...running.values()])
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS))
    await Promise.race([drain, timeout])

    if (running.size > 0) {
      log.warn("scheduler drain timeout, abandoning tasks", { remaining: running.size })
    }
    log.info("scheduler stopped")
  }

  /** Check for due tasks and execute them. */
  async function tick(): Promise<void> {
    const tasks = Schedule.due()
    if (tasks.length === 0) return

    log.info("scheduler tick: found due tasks", { count: tasks.length })

    for (const task of tasks) {
      // Skip if already running (prevent overlapping executions)
      if (running.has(task.id)) {
        log.info("scheduler: skipping, already running", { id: task.id, name: task.name })
        continue
      }

      // Execute in background — don't block the tick loop.
      // Store the promise so stop() can drain in-flight tasks.
      const promise = execute(task)
        .catch((err) => log.error("scheduler: execution error", { id: task.id, error: err }))
        .finally(() => running.delete(task.id))
      running.set(task.id, promise)
    }
  }

  /**
   * Trigger immediate execution of a task by ID.
   * Called from MCP schedule_trigger tool. Runs in background,
   * respects the running set to prevent overlaps.
   */
  export async function triggerNow(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = Schedule.get(taskId)
    if (!task) return { ok: false, error: `Task ${taskId} not found` }

    if (running.has(taskId)) {
      return { ok: false, error: `Task "${task.name}" is already running` }
    }

    // For triggerNow we await directly, but still register in the map
    // so stop() can see it during drain.
    let resolve: () => void
    const sentinel = new Promise<void>((r) => { resolve = r })
    running.set(taskId, sentinel)
    try {
      await execute(task)
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    } finally {
      resolve!()
      running.delete(taskId)
    }
  }

  /** Execute a single scheduled task with a timeout guard. */
  async function execute(task: Schedule.Info): Promise<void> {
    log.info("scheduler: executing task", { id: task.id, name: task.name })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS)

    try {
      // Race execution against timeout
      await Promise.race([
        executeInner(task),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new Error(`Task "${task.name}" timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`)),
          )
        }),
      ])
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      Schedule.recordExecution(task.id, { status: "error", error: errorMsg })
      log.error("scheduler: task failed", { id: task.id, name: task.name, error: errorMsg })
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Inner execution logic — separated so the timeout wrapper stays clean. */
  async function executeInner(task: Schedule.Info): Promise<void> {
    // Execute within the task's project context
    await Instance.provide({
      directory: task.directory,
      init: InstanceBootstrap,
      async fn() {
        // Create an isolated session for this execution
        const session = await Session.create({
          title: `Scheduled: ${task.name}`,
          // Auto-approve everything — scheduled tasks run unattended
          permission: [
            { permission: "question", action: "deny" as const, pattern: "*" },
            { permission: "plan_enter", action: "deny" as const, pattern: "*" },
            { permission: "plan_exit", action: "deny" as const, pattern: "*" },
          ],
        })

        log.info("scheduler: session created", { sessionID: session.id, task: task.name })

        // Run the prompt
        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: task.prompt }],
          agent: task.agent,
          model: task.model ? parseModel(task.model) : undefined,
        })

        // Extract the final assistant response
        const text = extractResult(session.id)

        // Deliver the result
        const delivery = task.delivery ?? { type: "session" as const }
        await Delivery.deliver(delivery, { text, sessionID: session.id, task })

        // Record success
        Schedule.recordExecution(task.id, { status: "success", sessionID: session.id })
        log.info("scheduler: task completed", { id: task.id, name: task.name, sessionID: session.id })
      },
    })
  }

  /** Parse a "provider/model" string into the format SessionPrompt expects. */
  function parseModel(model: string) {
    const slash = model.indexOf("/")
    if (slash === -1) return undefined
    return {
      providerID: ProviderID.make(model.slice(0, slash)),
      modelID: ModelID.make(model.slice(slash + 1)),
    }
  }

  /** Extract the last assistant text from a session's messages. */
  function extractResult(sessionID: string): string {
    const rows = Database.use((db) =>
      db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID as any)).all(),
    )

    // Find the last assistant message
    for (let i = rows.length - 1; i >= 0; i--) {
      const data = rows[i].data as any
      if (data?.role === "assistant") {
        // Extract text parts
        const parts = (data.parts ?? []) as MessageV2.Part[]
        const textParts = parts.filter((p): p is MessageV2.TextPart => p.type === "text")
        if (textParts.length > 0) {
          return textParts.map((p) => p.text).join("\n")
        }
      }
    }

    return "(no output)"
  }
}
