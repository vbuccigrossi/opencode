import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { EventJournal } from "../../src/bus/journal"
import { tmpdir } from "../fixture/fixture"
import { executeSchedule, executeDevice, executeToken } from "../../src/command/execute"

/**
 * Tests for direct command execution handlers.
 * These verify that /schedule, /device, /token subcommands
 * execute correctly without invoking the model.
 */
describe("executeSchedule", () => {
  async function withInstance(fn: () => Promise<void>): Promise<void> {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn })
  }

  test(
    "list returns empty message",
    async () => {
      await withInstance(async () => {
        const result = await executeSchedule("list")
        expect(result).toContain("No scheduled tasks")
      })
    },
    30_000,
  )

  test(
    "create and list",
    async () => {
      await withInstance(async () => {
        const create = await executeSchedule('create my-task "0 9 * * *" run tests daily')
        expect(create).toContain("Task created")
        expect(create).toContain("my-task")

        const list = await executeSchedule("list")
        expect(list).toContain("my-task")
      })
    },
    30_000,
  )

  test(
    "create validates cron",
    async () => {
      await withInstance(async () => {
        const result = await executeSchedule("create bad-task invalid-cron do something")
        expect(result).toContain("Invalid cron")
      })
    },
    30_000,
  )

  test(
    "create shows usage when missing args",
    async () => {
      await withInstance(async () => {
        expect(await executeSchedule("create")).toContain("Usage:")
        expect(await executeSchedule("create name-only")).toContain("Usage:")
      })
    },
    30_000,
  )

  test(
    "delete removes a task",
    async () => {
      await withInstance(async () => {
        const create = await executeSchedule('create del-task "0 1 * * *" test prompt')
        const id = create.match(/`(schd[^`]+)`/)?.[1]
        expect(id).toBeDefined()

        const del = await executeSchedule(`delete ${id}`)
        expect(del).toContain("Deleted")

        const list = await executeSchedule("list")
        expect(list).not.toContain("del-task")
      })
    },
    30_000,
  )

  test(
    "enable and disable",
    async () => {
      await withInstance(async () => {
        const create = await executeSchedule('create toggle-task "0 1 * * *" test')
        const id = create.match(/`(schd[^`]+)`/)?.[1]!

        const disable = await executeSchedule(`disable ${id}`)
        expect(disable).toContain("Disabled")

        const enable = await executeSchedule(`enable ${id}`)
        expect(enable).toContain("Enabled")
      })
    },
    30_000,
  )

  test(
    "unknown subcommand",
    async () => {
      await withInstance(async () => {
        const result = await executeSchedule("bogus")
        expect(result).toContain("Unknown subcommand")
      })
    },
    30_000,
  )

  test(
    "default is list",
    async () => {
      await withInstance(async () => {
        const result = await executeSchedule("")
        expect(result).toContain("No scheduled tasks")
      })
    },
    30_000,
  )
})

describe("executeDevice", () => {
  async function withInstance(fn: () => Promise<void>): Promise<void> {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn })
  }

  test(
    "register and list",
    async () => {
      await withInstance(async () => {
        const reg = await executeDevice("register exec-test-phone phone")
        expect(reg).toContain("Device registered")
        expect(reg).toContain("exec-test-phone")

        const list = await executeDevice("list")
        expect(list).toContain("exec-test-phone")
      })
    },
    30_000,
  )

  test(
    "register shows usage when missing name",
    async () => {
      await withInstance(async () => {
        const result = await executeDevice("register")
        expect(result).toContain("Usage:")
      })
    },
    30_000,
  )

  test(
    "remove deletes a device",
    async () => {
      await withInstance(async () => {
        const reg = await executeDevice("register remove-me phone")
        const id = reg.match(/`(dev_[^`]+)`/)?.[1]!

        const rm = await executeDevice(`remove ${id}`)
        expect(rm).toContain("Removed")
      })
    },
    30_000,
  )

  test(
    "sync works",
    async () => {
      await withInstance(async () => {
        EventJournal.start()

        const reg = await executeDevice("register sync-test phone")
        const id = reg.match(/`(dev_[^`]+)`/)?.[1]!

        const sync = await executeDevice(`sync ${id}`)
        expect(sync).toContain("Synced")
        expect(sync).toContain("Events:")

        EventJournal.stop()
      })
    },
    30_000,
  )

  test(
    "unknown subcommand",
    async () => {
      await withInstance(async () => {
        const result = await executeDevice("bogus")
        expect(result).toContain("Unknown subcommand")
      })
    },
    30_000,
  )
})

describe("executeToken", () => {
  async function withInstance(fn: () => Promise<void>): Promise<void> {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn })
  }

  test(
    "create and list",
    async () => {
      await withInstance(async () => {
        const create = await executeToken("create exec-test-token")
        expect(create).toContain("Token created")
        expect(create).toContain("ctx_")
        expect(create).toContain("Bearer")

        const list = await executeToken("list")
        expect(list).toContain("exec-test-token")
      })
    },
    30_000,
  )

  test(
    "create shows usage when missing name",
    async () => {
      await withInstance(async () => {
        const result = await executeToken("create")
        expect(result).toContain("Usage:")
      })
    },
    30_000,
  )

  test(
    "revoke removes a token",
    async () => {
      await withInstance(async () => {
        const create = await executeToken("create revoke-test")
        const id = create.match(/`(tok_[^`]+)`/)?.[1]!

        const revoke = await executeToken(`revoke ${id}`)
        expect(revoke).toContain("Revoked")
      })
    },
    30_000,
  )

  test(
    "unknown subcommand",
    async () => {
      await withInstance(async () => {
        const result = await executeToken("bogus")
        expect(result).toContain("Unknown subcommand")
      })
    },
    30_000,
  )
})
