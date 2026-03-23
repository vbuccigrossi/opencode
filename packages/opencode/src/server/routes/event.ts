import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { EventJournal } from "@/bus/journal"
import { lazy } from "../../util/lazy"
import { AsyncQueue } from "../../util/queue"
import { Instance } from "@/project/instance"
import z from "zod"

const log = Log.create({ service: "server" })

export const EventRoutes = lazy(() => {
  const app = new Hono()

  // ── Real-time SSE stream (enhanced with sequence numbers) ──

  app.get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description:
        "Server-Sent Events stream. Supports Last-Event-ID header for reconnection — " +
        "missed events are replayed from the journal before switching to live.",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(BusEvent.payloads()),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")

      // Check for Last-Event-ID header (reconnection catch-up)
      const lastEventId = c.req.header("Last-Event-ID")
      const replayFrom = lastEventId ? parseInt(lastEventId, 10) : undefined

      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<{ data: string; id?: string } | null>()
        let done = false

        // If reconnecting, replay missed events from journal
        if (replayFrom && !isNaN(replayFrom)) {
          const missed = EventJournal.replay(replayFrom, 500)
          log.info("replaying missed events", { from: replayFrom, count: missed.length })
          for (const entry of missed) {
            q.push({
              data: JSON.stringify(entry.payload),
              id: String(entry.seq),
            })
          }
        }

        q.push({
          data: JSON.stringify({
            type: "server.connected",
            properties: { seq: EventJournal.latestSeq() },
          }),
        })

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push({
            data: JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          })
        }, 10_000)

        const unsub = Bus.subscribeAll((event) => {
          const seq = EventJournal.latestSeq()
          q.push({
            data: JSON.stringify(event),
            id: String(seq),
          })
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          q.push(null)
          log.info("event disconnected")
        }

        stream.onAbort(stop)

        try {
          for await (const item of q) {
            if (item === null) return
            await stream.writeSSE(item)
          }
        } finally {
          stop()
        }
      })
    },
  )

  // ── Event replay (REST — for clients that can't use SSE) ──

  app.get(
    "/event/replay",
    describeRoute({
      summary: "Replay events from journal",
      description:
        "Fetch events from the event journal. Use `after` to get events after a sequence number, " +
        "or `since` to get events after a timestamp (ms epoch). Returns up to `limit` events.",
      operationId: "event.replay",
      responses: {
        200: {
          description: "Event entries with sequence numbers",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  events: z.array(
                    z.object({
                      seq: z.number(),
                      type: z.string(),
                      payload: z.any(),
                      timeCreated: z.number(),
                    }),
                  ),
                  latestSeq: z.number(),
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const after = c.req.query("after")
      const since = c.req.query("since")
      const limitStr = c.req.query("limit")
      const limit = limitStr ? Math.min(parseInt(limitStr, 10), 500) : 200

      let events: EventJournal.Entry[]
      if (after) {
        events = EventJournal.replay(parseInt(after, 10), limit)
      } else if (since) {
        events = EventJournal.since(parseInt(since, 10), limit)
      } else {
        // Default: return latest events
        events = EventJournal.replay(0, limit)
      }

      return c.json({
        events,
        latestSeq: EventJournal.latestSeq(),
      })
    },
  )

  return app
})
