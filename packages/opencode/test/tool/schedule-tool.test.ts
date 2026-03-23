import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests for the schedule agent tool.
 * Validates that the tool correctly wraps Schedule module CRUD operations.
 */
describe("ScheduleTool", () => {
  async function withInstance(fn: () => Promise<void>): Promise<void> {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn })
  }

  /** Helper to call the tool's execute function directly. */
  async function callTool(params: Record<string, any>) {
    const { ScheduleTool } = await import("../../src/tool/schedule")
    const tool = await ScheduleTool.init()
    return tool.execute(params as any, {} as any)
  }

  test(
    "list returns empty when no tasks",
    async () => {
      await withInstance(async () => {
        const result = await callTool({ operation: "list" })
        expect(result.output).toContain("No scheduled tasks")
        expect(result.metadata.count).toBe(0)
      })
    },
    30_000,
  )

  test(
    "create and list a task",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "Test Task",
          cron: "0 9 * * *",
          prompt: "Run daily check",
        })
        expect(create.output).toContain("Task created")
        expect(create.output).toContain("Test Task")
        expect(create.metadata.id).toBeDefined()

        const list = await callTool({ operation: "list" })
        expect(list.output).toContain("Test Task")
        expect(list.metadata.count).toBe(1)
      })
    },
    30_000,
  )

  test(
    "get returns task details",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "Get Task",
          cron: "*/10 * * * *",
          prompt: "check stuff",
        })

        const get = await callTool({ operation: "get", id: create.metadata.id })
        expect(get.output).toContain("Get Task")
        expect(get.output).toContain("*/10 * * * *")
      })
    },
    30_000,
  )

  test(
    "update modifies task fields",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "Old Name",
          cron: "0 1 * * *",
          prompt: "do things",
        })

        const update = await callTool({
          operation: "update",
          id: create.metadata.id,
          name: "New Name",
          cron: "0 2 * * *",
        })
        expect(update.output).toContain("New Name")
        expect(update.output).toContain("0 2 * * *")
      })
    },
    30_000,
  )

  test(
    "delete removes a task",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "Delete Me",
          cron: "0 1 * * *",
          prompt: "gone",
        })

        const del = await callTool({ operation: "delete", id: create.metadata.id })
        expect(del.output).toContain("Deleted")

        const get = await callTool({ operation: "get", id: create.metadata.id })
        expect(get.output).toContain("not found")
      })
    },
    30_000,
  )

  test(
    "create validates cron expression",
    async () => {
      await withInstance(async () => {
        await expect(
          callTool({
            operation: "create",
            name: "Bad Cron",
            cron: "not valid",
            prompt: "fail",
          }),
        ).rejects.toThrow("Invalid cron")
      })
    },
    30_000,
  )

  test(
    "create with file delivery",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "File Task",
          cron: "0 0 * * *",
          prompt: "generate report",
          delivery_type: "file",
          delivery_path: "/tmp/report.md",
        })
        expect(create.output).toContain("File Task")
        expect(create.output).toContain("file")
      })
    },
    30_000,
  )

  test(
    "create requires name, cron, prompt",
    async () => {
      await withInstance(async () => {
        await expect(callTool({ operation: "create" })).rejects.toThrow("name is required")
        await expect(callTool({ operation: "create", name: "X" })).rejects.toThrow("cron is required")
        await expect(callTool({ operation: "create", name: "X", cron: "0 1 * * *" })).rejects.toThrow(
          "prompt is required",
        )
      })
    },
    30_000,
  )
})
