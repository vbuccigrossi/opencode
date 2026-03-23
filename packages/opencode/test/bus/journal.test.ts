import { describe, expect, test } from "bun:test"
import { EventJournal } from "../../src/bus/journal"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import z from "zod"

// Define a test event type
const TestEvent = BusEvent.define("test.journal.event", z.object({ value: z.string() }))

describe("EventJournal", () => {
  test(
    "start and stop without error",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()
          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "records bus events with sequence numbers",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          await Bus.publish(TestEvent, { value: "hello" })
          await Bus.publish(TestEvent, { value: "world" })

          // Small delay for async processing
          await new Promise((r) => setTimeout(r, 50))

          const entries = EventJournal.replay(0)
          expect(entries.length).toBeGreaterThanOrEqual(2)

          // Verify sequence numbers are increasing
          for (let i = 1; i < entries.length; i++) {
            expect(entries[i].seq).toBeGreaterThan(entries[i - 1].seq)
          }

          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "replay returns events after given seq",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          await Bus.publish(TestEvent, { value: "first" })
          await Bus.publish(TestEvent, { value: "second" })
          await Bus.publish(TestEvent, { value: "third" })

          await new Promise((r) => setTimeout(r, 50))

          const all = EventJournal.replay(0)
          expect(all.length).toBeGreaterThanOrEqual(3)

          // Get events after the first one
          const afterFirst = EventJournal.replay(all[0].seq)
          expect(afterFirst.length).toBe(all.length - 1)

          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "latestSeq returns current sequence number",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          const before = EventJournal.latestSeq()
          await Bus.publish(TestEvent, { value: "bump" })
          await new Promise((r) => setTimeout(r, 50))

          const after = EventJournal.latestSeq()
          expect(after).toBeGreaterThan(before)

          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "since returns events after timestamp",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          const beforeTime = Date.now()
          await new Promise((r) => setTimeout(r, 10))

          await Bus.publish(TestEvent, { value: "after-timestamp" })
          await new Promise((r) => setTimeout(r, 50))

          const entries = EventJournal.since(beforeTime)
          expect(entries.length).toBeGreaterThanOrEqual(1)

          const found = entries.some((e) => {
            const payload = e.payload as any
            return payload?.properties?.value === "after-timestamp"
          })
          expect(found).toBe(true)

          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "skips heartbeat and connected events",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          // Publish a real event
          await Bus.publish(TestEvent, { value: "real-event" })
          await new Promise((r) => setTimeout(r, 50))

          const entries = EventJournal.replay(0)
          const types = entries.map((e) => e.type)

          // Should not contain heartbeat or connected events
          expect(types).not.toContain("server.heartbeat")
          expect(types).not.toContain("server.connected")

          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "replay with limit",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          for (let i = 0; i < 5; i++) {
            await Bus.publish(TestEvent, { value: `event-${i}` })
          }
          await new Promise((r) => setTimeout(r, 50))

          const limited = EventJournal.replay(0, 2)
          expect(limited).toHaveLength(2)

          EventJournal.stop()
        },
      })
    },
    30_000,
  )
})
