import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests for the token agent tool.
 * Validates that the tool correctly wraps ApiToken module operations.
 */
describe("TokenTool", () => {
  async function withInstance(fn: () => Promise<void>): Promise<void> {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn })
  }

  async function callTool(params: Record<string, any>) {
    const { TokenTool } = await import("../../src/tool/token")
    const tool = await TokenTool.init()
    return tool.execute(params as any, {} as any)
  }

  test(
    "create and list a token",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "Test Token",
        })
        expect(create.output).toContain("Token created")
        expect(create.output).toContain("ctx_")
        expect(create.output).toContain("Bearer")
        expect(create.metadata.id).toBeDefined()
        expect(create.metadata.prefix).toStartWith("ctx_")

        const list = await callTool({ operation: "list" })
        expect(list.output).toContain("Test Token")
        expect(list.metadata.count).toBeGreaterThanOrEqual(1)
      })
    },
    30_000,
  )

  test(
    "create with custom scopes",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "Scoped Token",
          scopes: ["schedule:read", "session:write"],
        })
        expect(create.output).toContain("Scoped Token")

        const list = await callTool({ operation: "list" })
        expect(list.output).toContain("schedule:read")
        expect(list.output).toContain("session:write")
      })
    },
    30_000,
  )

  test(
    "create with expiration",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "Expiring Token",
          expires_in_hours: 24,
        })
        expect(create.output).toContain("Expiring Token")
      })
    },
    30_000,
  )

  test(
    "revoke removes a token",
    async () => {
      await withInstance(async () => {
        const create = await callTool({
          operation: "create",
          name: "Revoke Me",
        })

        const revoke = await callTool({ operation: "revoke", id: create.metadata.id })
        expect(revoke.output).toContain("Revoked")

        const list = await callTool({ operation: "list" })
        expect(list.output).not.toContain("Revoke Me")
      })
    },
    30_000,
  )

  test(
    "create requires name",
    async () => {
      await withInstance(async () => {
        await expect(callTool({ operation: "create" })).rejects.toThrow("name is required")
      })
    },
    30_000,
  )

  test(
    "revoke requires id",
    async () => {
      await withInstance(async () => {
        await expect(callTool({ operation: "revoke" })).rejects.toThrow("id is required")
      })
    },
    30_000,
  )

  test(
    "revoke throws for non-existent token",
    async () => {
      await withInstance(async () => {
        await expect(callTool({ operation: "revoke", id: "tok_fake" })).rejects.toThrow("not found")
      })
    },
    30_000,
  )
})
