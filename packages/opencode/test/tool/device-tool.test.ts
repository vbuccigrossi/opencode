import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { EventJournal } from "../../src/bus/journal"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { tmpdir } from "../fixture/fixture"
import z from "zod"

const TestEvent = BusEvent.define("test.device-tool.event", z.object({ msg: z.string() }))

/**
 * Tests for the device agent tool.
 * Validates that the tool correctly wraps Device/DeviceSync module operations.
 */
describe("DeviceTool", () => {
  async function withInstance(fn: () => Promise<void>): Promise<void> {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn })
  }

  async function callTool(params: Record<string, any>) {
    const { DeviceTool } = await import("../../src/tool/device")
    const tool = await DeviceTool.init()
    return tool.execute(params as any, {} as any)
  }

  test(
    "register and list a device",
    async () => {
      await withInstance(async () => {
        const reg = await callTool({
          operation: "register",
          name: "ToolTestPhone",
          type: "phone",
        })
        expect(reg.output).toContain("Device registered")
        expect(reg.output).toContain("ToolTestPhone")
        expect(reg.metadata.id).toStartWith("dev_")

        const list = await callTool({ operation: "list" })
        expect(list.output).toContain("ToolTestPhone")
        expect(list.metadata.count).toBeGreaterThanOrEqual(1)
      })
    },
    30_000,
  )

  test(
    "get returns device details",
    async () => {
      await withInstance(async () => {
        const reg = await callTool({
          operation: "register",
          name: "Get Device",
          type: "laptop",
        })

        const get = await callTool({ operation: "get", id: reg.metadata.id })
        expect(get.output).toContain("Get Device")
        expect(get.output).toContain("laptop")
      })
    },
    30_000,
  )

  test(
    "update modifies device fields",
    async () => {
      await withInstance(async () => {
        const reg = await callTool({
          operation: "register",
          name: "Old Device",
        })

        const update = await callTool({
          operation: "update",
          id: reg.metadata.id,
          name: "New Device",
          type: "tablet",
          push_url: "https://example.com/hook",
        })
        expect(update.output).toContain("New Device")
        expect(update.output).toContain("tablet")
      })
    },
    30_000,
  )

  test(
    "remove deletes a device",
    async () => {
      await withInstance(async () => {
        const reg = await callTool({
          operation: "register",
          name: "Remove Me",
        })

        const rm = await callTool({ operation: "remove", id: reg.metadata.id })
        expect(rm.output).toContain("Removed")

        const get = await callTool({ operation: "get", id: reg.metadata.id })
        expect(get.output).toContain("not found")
      })
    },
    30_000,
  )

  test(
    "sync returns events",
    async () => {
      await withInstance(async () => {
        EventJournal.start()

        const reg = await callTool({
          operation: "register",
          name: "Sync Device",
        })

        await Bus.publish(TestEvent, { msg: "hello" })
        await new Promise((r) => setTimeout(r, 50))

        const sync = await callTool({
          operation: "sync",
          id: reg.metadata.id,
        })
        expect(sync.metadata.events).toBeGreaterThanOrEqual(1)
        expect(sync.output).toContain("Events returned:")

        EventJournal.stop()
      })
    },
    30_000,
  )

  test(
    "register requires name",
    async () => {
      await withInstance(async () => {
        await expect(callTool({ operation: "register" })).rejects.toThrow("name is required")
      })
    },
    30_000,
  )

  test(
    "get returns not found for missing device",
    async () => {
      await withInstance(async () => {
        const result = await callTool({ operation: "get", id: "dev_nonexistent" })
        expect(result.output).toContain("not found")
      })
    },
    30_000,
  )
})
