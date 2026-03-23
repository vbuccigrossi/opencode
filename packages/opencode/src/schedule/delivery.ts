import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import path from "path"
import type { Schedule } from "./index"

const log = Log.create({ service: "schedule.delivery" })

/**
 * Delivery handlers for scheduled task results.
 * Each handler takes the delivery config and the task output text,
 * and delivers it to the configured target.
 */
export namespace Delivery {
  export interface Result {
    /** The final assistant text from the session. */
    text: string
    /** The session ID where the task executed. */
    sessionID: string
    /** The task that produced this result. */
    task: Schedule.Info
  }

  /**
   * Deliver a task result according to its delivery configuration.
   * Returns true if delivery succeeded.
   */
  export async function deliver(config: Schedule.DeliveryConfig, result: Result): Promise<boolean> {
    switch (config.type) {
      case "session":
        // No-op — result is already in the session
        log.info("delivery: session (no-op)", { sessionID: result.sessionID })
        return true

      case "file":
        return deliverFile(config.path, result)

      case "webhook":
        return deliverWebhook(config.url, config.headers as Record<string, string> | undefined, result)

      default:
        log.warn("unknown delivery type", { config })
        return false
    }
  }

  async function deliverFile(filePath: string, result: Result): Promise<boolean> {
    try {
      // Expand ~ to home dir
      const resolved = filePath.startsWith("~")
        ? path.join(process.env.HOME ?? "/tmp", filePath.slice(1))
        : filePath

      // Prepend metadata header
      const content = [
        `# ${result.task.name}`,
        `> Generated: ${new Date().toISOString()}`,
        `> Session: ${result.sessionID}`,
        "",
        result.text,
        "",
      ].join("\n")

      await Filesystem.write(resolved, content)
      log.info("delivery: file written", { path: resolved })
      return true
    } catch (err) {
      log.error("delivery: file failed", { path: filePath, error: err })
      return false
    }
  }

  const WEBHOOK_MAX_RETRIES = 2
  const WEBHOOK_RETRY_DELAY_MS = 3000

  async function deliverWebhook(
    url: string,
    headers: Record<string, string> | undefined,
    result: Result,
  ): Promise<boolean> {
    const body = JSON.stringify({
      task: {
        id: result.task.id,
        name: result.task.name,
        cron: result.task.cron,
      },
      sessionID: result.sessionID,
      text: result.text,
      timestamp: Date.now(),
    })

    for (let attempt = 0; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          log.info("delivery: webhook retry", { url, attempt })
          await new Promise((r) => setTimeout(r, WEBHOOK_RETRY_DELAY_MS))
        }

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body,
        })

        if (response.ok) {
          log.info("delivery: webhook sent", { url, status: response.status })
          return true
        }

        // 4xx errors are not retryable (client error)
        if (response.status >= 400 && response.status < 500) {
          log.error("delivery: webhook rejected (not retrying)", { url, status: response.status })
          return false
        }

        log.error("delivery: webhook failed", { url, status: response.status, attempt })
      } catch (err) {
        log.error("delivery: webhook error", { url, error: err, attempt })
      }
    }

    log.error("delivery: webhook exhausted retries", { url, retries: WEBHOOK_MAX_RETRIES })
    return false
  }
}
