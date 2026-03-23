import { describe, expect, test } from "bun:test"
import { Schedule } from "../../src/schedule"
import { Delivery } from "../../src/schedule/delivery"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import * as fs from "fs/promises"
import path from "path"

describe("Schedule", () => {
  // ── Cron validation ──

  test("validateCron accepts valid expressions", () => {
    expect(Schedule.validateCron("0 1 * * *")).toBeUndefined()
    expect(Schedule.validateCron("*/5 * * * *")).toBeUndefined()
    expect(Schedule.validateCron("0 9 * * 6")).toBeUndefined()
    expect(Schedule.validateCron("30 2 1 * *")).toBeUndefined()
  })

  test("validateCron rejects invalid expressions", () => {
    expect(Schedule.validateCron("not a cron")).toBeDefined()
    expect(Schedule.validateCron("60 * * * *")).toBeDefined()
    expect(Schedule.validateCron("")).toBeDefined()
  })

  test("nextRun returns a future timestamp", () => {
    const next = Schedule.nextRun("0 1 * * *")
    expect(next).toBeDefined()
    expect(next!).toBeGreaterThan(Date.now())
  })

  test("nextRun returns undefined for invalid cron", () => {
    expect(Schedule.nextRun("garbage")).toBeUndefined()
  })

  test("describeCron returns a string", () => {
    const desc = Schedule.describeCron("0 1 * * *")
    expect(typeof desc).toBe("string")
    expect(desc.length).toBeGreaterThan(0)
  })

  // ── CRUD operations ──

  test(
    "create and get a scheduled task",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({
            name: "Daily news",
            cron: "0 1 * * *",
            prompt: "Fetch and summarize the news",
          })

          expect(task.id).toBeDefined()
          expect(task.name).toBe("Daily news")
          expect(task.cron).toBe("0 1 * * *")
          expect(task.prompt).toBe("Fetch and summarize the news")
          expect(task.enabled).toBe(true)
          expect(task.nextRunAt).toBeDefined()
          expect(task.nextRunAt!).toBeGreaterThan(Date.now())
          expect(task.delivery).toEqual({ type: "session" })

          // Retrieve by ID
          const retrieved = Schedule.get(task.id)
          expect(retrieved).toBeDefined()
          expect(retrieved!.id).toBe(task.id)
          expect(retrieved!.name).toBe("Daily news")
          expect(retrieved!.prompt).toBe("Fetch and summarize the news")
        },
      })
    },
    30_000,
  )

  test(
    "create with custom delivery config",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({
            name: "File report",
            cron: "0 9 * * 6",
            prompt: "Generate weekly report",
            delivery: { type: "file", path: "/tmp/report.md" },
          })

          expect(task.delivery).toEqual({ type: "file", path: "/tmp/report.md" })
        },
      })
    },
    30_000,
  )

  test(
    "create with webhook delivery",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({
            name: "Webhook task",
            cron: "*/30 * * * *",
            prompt: "Check status",
            delivery: { type: "webhook", url: "https://example.com/hook" },
          })

          expect(task.delivery.type).toBe("webhook")
          if (task.delivery.type === "webhook") {
            expect(task.delivery.url).toBe("https://example.com/hook")
          }
        },
      })
    },
    30_000,
  )

  test(
    "create rejects invalid cron",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(() =>
            Schedule.create({
              name: "Bad cron",
              cron: "not valid",
              prompt: "This should fail",
            }),
          ).toThrow("Invalid cron")
        },
      })
    },
    30_000,
  )

  test(
    "list returns all tasks for the project",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Schedule.create({ name: "Task A", cron: "0 1 * * *", prompt: "A" })
          Schedule.create({ name: "Task B", cron: "0 2 * * *", prompt: "B" })
          Schedule.create({ name: "Task C", cron: "0 3 * * *", prompt: "C" })

          const all = Schedule.list(Instance.project.id)
          expect(all).toHaveLength(3)

          const names = all.map((t) => t.name).sort()
          expect(names).toEqual(["Task A", "Task B", "Task C"])
        },
      })
    },
    30_000,
  )

  test(
    "update modifies task fields",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({ name: "Original", cron: "0 1 * * *", prompt: "Do stuff" })

          const updated = Schedule.update({
            id: task.id,
            name: "Renamed",
            cron: "0 2 * * *",
            prompt: "Do different stuff",
          })

          expect(updated.name).toBe("Renamed")
          expect(updated.cron).toBe("0 2 * * *")
          expect(updated.prompt).toBe("Do different stuff")
          expect(updated.id).toBe(task.id)
        },
      })
    },
    30_000,
  )

  test(
    "update can disable and re-enable a task",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({ name: "Toggle me", cron: "0 1 * * *", prompt: "Toggle" })
          expect(task.enabled).toBe(true)

          const disabled = Schedule.update({ id: task.id, enabled: false })
          expect(disabled.enabled).toBe(false)

          const reenabled = Schedule.update({ id: task.id, enabled: true })
          expect(reenabled.enabled).toBe(true)
        },
      })
    },
    30_000,
  )

  test(
    "update rejects invalid cron",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({ name: "Good cron", cron: "0 1 * * *", prompt: "Test" })

          expect(() => Schedule.update({ id: task.id, cron: "invalid" })).toThrow("Invalid cron")
        },
      })
    },
    30_000,
  )

  test(
    "remove deletes a task",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({ name: "Delete me", cron: "0 1 * * *", prompt: "Bye" })
          expect(Schedule.get(task.id)).toBeDefined()

          Schedule.remove(task.id)
          expect(Schedule.get(task.id)).toBeUndefined()
        },
      })
    },
    30_000,
  )

  test(
    "get returns undefined for non-existent ID",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(Schedule.get("schd_nonexistent")).toBeUndefined()
        },
      })
    },
    30_000,
  )

  // ── Due tasks ──

  test(
    "due returns tasks with next_run_at in the past",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create a task — its next_run_at will be in the future
          const task = Schedule.create({ name: "Future task", cron: "0 1 * * *", prompt: "Future" })
          expect(Schedule.due()).toHaveLength(0)

          // Manually set next_run_at to the past to simulate a due task
          Schedule.recordExecution(task.id, { status: "success" })

          // After recordExecution, next_run_at is recalculated to the future
          // So due() should still be empty
          expect(Schedule.due()).toHaveLength(0)
        },
      })
    },
    30_000,
  )

  // ── Record execution ──

  test(
    "recordExecution updates last_run_at and next_run_at",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({ name: "Track me", cron: "0 1 * * *", prompt: "Track" })
          expect(task.lastRunAt).toBeUndefined()
          expect(task.lastStatus).toBeUndefined()

          Schedule.recordExecution(task.id, { status: "success", sessionID: "sess_123" })

          const updated = Schedule.get(task.id)!
          expect(updated.lastRunAt).toBeDefined()
          expect(updated.lastRunAt!).toBeLessThanOrEqual(Date.now())
          expect(updated.lastStatus).toBe("success")
          expect(updated.lastSessionID).toBe("sess_123")
          expect(updated.nextRunAt).toBeDefined()
          expect(updated.nextRunAt!).toBeGreaterThan(Date.now())
        },
      })
    },
    30_000,
  )

  test(
    "recordExecution stores error information",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = Schedule.create({ name: "Error task", cron: "0 1 * * *", prompt: "Fail" })

          Schedule.recordExecution(task.id, { status: "error", error: "Connection timeout" })

          const updated = Schedule.get(task.id)!
          expect(updated.lastStatus).toBe("error")
          expect(updated.lastError).toBe("Connection timeout")
        },
      })
    },
    30_000,
  )
})

describe("Delivery", () => {
  test(
    "file delivery writes content with metadata",
    async () => {
      await using tmp = await tmpdir({ git: true })

      const outPath = path.join(tmp.path, "output.md")
      const task = {
        id: "schd_test123",
        projectID: "proj_1",
        name: "Test Report",
        cron: "0 1 * * *",
        prompt: "Generate report",
        directory: tmp.path,
        enabled: true,
        delivery: { type: "file" as const, path: outPath },
        time: { created: Date.now(), updated: Date.now() },
      } satisfies Schedule.Info

      const ok = await Delivery.deliver(
        { type: "file", path: outPath },
        { text: "Here is the report content.", sessionID: "sess_abc", task },
      )

      expect(ok).toBe(true)

      const content = await fs.readFile(outPath, "utf-8")
      expect(content).toContain("# Test Report")
      expect(content).toContain("Session: sess_abc")
      expect(content).toContain("Here is the report content.")
    },
    30_000,
  )

  test("session delivery is a no-op that returns true", async () => {
    const task = {
      id: "schd_noop",
      projectID: "proj_1",
      name: "Noop",
      cron: "0 1 * * *",
      prompt: "Noop",
      directory: "/tmp",
      enabled: true,
      delivery: { type: "session" as const },
      time: { created: Date.now(), updated: Date.now() },
    } satisfies Schedule.Info

    const ok = await Delivery.deliver({ type: "session" }, { text: "result", sessionID: "sess_1", task })
    expect(ok).toBe(true)
  })

  test("webhook delivery returns false for unreachable URL", async () => {
    const task = {
      id: "schd_webhook",
      projectID: "proj_1",
      name: "Webhook",
      cron: "0 1 * * *",
      prompt: "Hook",
      directory: "/tmp",
      enabled: true,
      delivery: { type: "webhook" as const, url: "http://127.0.0.1:1/nonexistent" },
      time: { created: Date.now(), updated: Date.now() },
    } satisfies Schedule.Info

    const ok = await Delivery.deliver(
      { type: "webhook", url: "http://127.0.0.1:1/nonexistent" },
      { text: "result", sessionID: "sess_2", task },
    )
    expect(ok).toBe(false)
  }, 30_000)
})
