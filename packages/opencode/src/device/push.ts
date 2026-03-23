import { Device } from "./index"
import { Bus } from "../bus"
import { Log } from "../util/log"

const log = Log.create({ service: "device.push" })

/**
 * Push notification system for registered devices.
 *
 * Subscribes to all Bus events and forwards them to devices
 * that have a push_url configured and whose event filters match.
 * Uses fire-and-forget delivery with single retry on failure.
 */
export namespace DevicePush {
  let unsub: (() => void) | undefined

  /** Start listening for events to push. Call within Instance context. */
  export function start(): void {
    if (unsub) return

    unsub = Bus.subscribeAll(async (event) => {
      // Skip internal/noise events
      if (
        event.type === "server.heartbeat" ||
        event.type === "server.connected" ||
        event.type === "server.instance.disposed"
      ) {
        return
      }

      try {
        const targets = Device.getPushTargets(event.type)
        if (targets.length === 0) return

        log.info("pushing event to devices", { type: event.type, deviceCount: targets.length })

        // Fire-and-forget — don't block the Bus
        for (const device of targets) {
          pushToDevice(device, event).catch((err) =>
            log.error("push failed", { device: device.id, error: err }),
          )
        }
      } catch (err) {
        // Device module might not be ready yet — silently skip
        log.error("push error", { error: err })
      }
    })

    log.info("device push started")
  }

  /** Stop pushing events. */
  export function stop(): void {
    if (!unsub) return
    unsub()
    unsub = undefined
    log.info("device push stopped")
  }

  /** Push a single event to a single device with one retry. */
  async function pushToDevice(device: Device.Info, event: unknown): Promise<void> {
    if (!device.pushUrl) return

    const body = JSON.stringify({
      deviceID: device.id,
      event,
      timestamp: Date.now(),
    })

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Cortex-Device": device.id,
      ...(device.pushHeaders ?? {}),
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 2000))
        }

        const response = await fetch(device.pushUrl, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000), // 10s timeout
        })

        if (response.ok) {
          log.info("push delivered", { device: device.id, status: response.status })
          return
        }

        // 4xx = client error, don't retry
        if (response.status >= 400 && response.status < 500) {
          log.error("push rejected", { device: device.id, status: response.status })
          return
        }

        log.error("push failed", { device: device.id, status: response.status, attempt })
      } catch (err) {
        log.error("push error", { device: device.id, attempt, error: err })
      }
    }
  }
}
