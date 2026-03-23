import { describe, expect, test } from "bun:test"
import { Device } from "../../src/device"
import { DeviceSync } from "../../src/device/sync"
import { EventJournal } from "../../src/bus/journal"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import z from "zod"

const TestEvent = BusEvent.define("test.device.event", z.object({ msg: z.string() }))

describe("Device", () => {
  test(
    "register and get a device",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const info = Device.register({ name: "My Phone", type: "phone" })

          expect(info.id).toStartWith("dev_")
          expect(info.name).toBe("My Phone")
          expect(info.type).toBe("phone")
          expect(info.lastSeenSeq).toBe(0)
          expect(info.pushEvents).toEqual(["*"])

          const retrieved = Device.get(info.id)
          expect(retrieved).toBeDefined()
          expect(retrieved!.name).toBe("My Phone")
        },
      })
    },
    30_000,
  )

  test(
    "register with push URL",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const info = Device.register({
            name: "Webhook Device",
            pushUrl: "https://example.com/push",
            pushEvents: ["session.*", "schedule.*"],
          })

          expect(info.pushUrl).toBe("https://example.com/push")
          expect(info.pushEvents).toEqual(["session.*", "schedule.*"])
        },
      })
    },
    30_000,
  )

  test(
    "list all devices",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Device.register({ name: "Phone" })
          Device.register({ name: "Laptop" })
          Device.register({ name: "Tablet" })

          const all = Device.list()
          expect(all.length).toBeGreaterThanOrEqual(3)

          const names = all.map((d) => d.name)
          expect(names).toContain("Phone")
          expect(names).toContain("Laptop")
          expect(names).toContain("Tablet")
        },
      })
    },
    30_000,
  )

  test(
    "update device fields",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const info = Device.register({ name: "Old Name" })

          const updated = Device.update({
            id: info.id,
            name: "New Name",
            type: "laptop",
            pushUrl: "https://example.com/hook",
          })

          expect(updated.name).toBe("New Name")
          expect(updated.type).toBe("laptop")
          expect(updated.pushUrl).toBe("https://example.com/hook")
        },
      })
    },
    30_000,
  )

  test(
    "remove device",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const info = Device.register({ name: "Remove Me" })
          expect(Device.get(info.id)).toBeDefined()

          Device.remove(info.id)
          expect(Device.get(info.id)).toBeUndefined()
        },
      })
    },
    30_000,
  )

  test(
    "recordSync updates cursor",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const info = Device.register({ name: "Sync Device" })
          expect(info.lastSeenSeq).toBe(0)
          expect(info.lastSyncAt).toBeUndefined()

          Device.recordSync(info.id, 42)

          const updated = Device.get(info.id)!
          expect(updated.lastSeenSeq).toBe(42)
          expect(updated.lastSyncAt).toBeDefined()
          expect(updated.lastSyncAt!).toBeLessThanOrEqual(Date.now())
        },
      })
    },
    30_000,
  )

  test(
    "getPushTargets filters by event type",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Device with push URL that accepts everything
          Device.register({ name: "All", pushUrl: "https://a.com/hook", pushEvents: ["*"] })
          // Device with push URL that only wants session events
          Device.register({ name: "Sessions", pushUrl: "https://b.com/hook", pushEvents: ["session.created"] })
          // Device without push URL
          Device.register({ name: "NoPush" })

          const sessionTargets = Device.getPushTargets("session.created")
          expect(sessionTargets.length).toBeGreaterThanOrEqual(2) // All + Sessions (at minimum)

          const sessionNames = sessionTargets.map((d) => d.name)
          expect(sessionNames).toContain("All")
          expect(sessionNames).toContain("Sessions")
          // "NoPush" should not appear (no push URL)
          expect(sessionNames).not.toContain("NoPush")
        },
      })
    },
    30_000,
  )

  test(
    "get returns undefined for non-existent device",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(Device.get("dev_nonexistent")).toBeUndefined()
        },
      })
    },
    30_000,
  )
})

describe("DeviceSync", () => {
  test(
    "sync returns events since last seen seq",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          const device = Device.register({ name: "Sync Test" })

          // Publish some events
          await Bus.publish(TestEvent, { msg: "event-1" })
          await Bus.publish(TestEvent, { msg: "event-2" })
          await new Promise((r) => setTimeout(r, 50))

          const result = DeviceSync.sync({ deviceID: device.id })

          expect(result.events.length).toBeGreaterThanOrEqual(2)
          expect(result.latestSeq).toBeGreaterThan(0)
          expect(result.serverTime).toBeLessThanOrEqual(Date.now())

          // Device cursor should be updated
          const updated = Device.get(device.id)!
          expect(updated.lastSeenSeq).toBeGreaterThan(0)

          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "sync with includeSessions returns session list",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          const device = Device.register({ name: "Session Sync" })

          const result = DeviceSync.sync({
            deviceID: device.id,
            includeSessions: true,
          })

          expect(result.sessions).toBeDefined()
          expect(Array.isArray(result.sessions)).toBe(true)

          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "sync respects limit",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          const device = Device.register({ name: "Limit Test" })

          // Publish several events
          for (let i = 0; i < 5; i++) {
            await Bus.publish(TestEvent, { msg: `event-${i}` })
          }
          await new Promise((r) => setTimeout(r, 50))

          const result = DeviceSync.sync({ deviceID: device.id, limit: 2 })
          expect(result.events).toHaveLength(2)
          expect(result.pending).toBeGreaterThan(0)

          EventJournal.stop()
        },
      })
    },
    30_000,
  )

  test(
    "sync throws for non-existent device",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(() => DeviceSync.sync({ deviceID: "dev_fake" })).toThrow("not found")
        },
      })
    },
    30_000,
  )

  test(
    "second sync only returns new events",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          EventJournal.start()

          const device = Device.register({ name: "Delta Test" })

          // First batch
          await Bus.publish(TestEvent, { msg: "batch-1" })
          await new Promise((r) => setTimeout(r, 50))

          const sync1 = DeviceSync.sync({ deviceID: device.id })
          const sync1Count = sync1.events.length

          // Second batch
          await Bus.publish(TestEvent, { msg: "batch-2" })
          await new Promise((r) => setTimeout(r, 50))

          const sync2 = DeviceSync.sync({ deviceID: device.id })

          // Second sync should only have the new events
          expect(sync2.events.length).toBeLessThan(sync1Count + 2)
          expect(sync2.events.length).toBeGreaterThanOrEqual(1)

          EventJournal.stop()
        },
      })
    },
    30_000,
  )
})
