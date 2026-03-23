import { describe, expect, test } from "bun:test"
import { ApiToken } from "../../src/auth/token"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("ApiToken", () => {
  test(
    "create returns token and info",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { token, info } = await ApiToken.create({ name: "test-token" })

          expect(token).toStartWith("ctx_")
          expect(token.length).toBe(52) // "ctx_" + 48 hex chars
          expect(info.id).toStartWith("tok_")
          expect(info.name).toBe("test-token")
          expect(info.prefix).toBe(token.slice(0, 8))
          expect(info.scopes).toEqual(["*"])
          expect(info.expiresAt).toBeUndefined()
          expect(info.time.created).toBeLessThanOrEqual(Date.now())
        },
      })
    },
    30_000,
  )

  test(
    "validate accepts valid token",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { token } = await ApiToken.create({ name: "valid-token" })

          const info = await ApiToken.validate(token)
          expect(info).toBeDefined()
          expect(info!.name).toBe("valid-token")
          expect(info!.lastUsedAt).toBeDefined()
        },
      })
    },
    30_000,
  )

  test(
    "validate rejects invalid token",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const info = await ApiToken.validate("ctx_0000000000000000000000000000000000000000000000000")
          expect(info).toBeUndefined()
        },
      })
    },
    30_000,
  )

  test(
    "validate rejects non-ctx prefix",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const info = await ApiToken.validate("some-random-string")
          expect(info).toBeUndefined()
        },
      })
    },
    30_000,
  )

  test(
    "validate rejects expired token",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Create a token that expired 1 hour ago
          const { token } = await ApiToken.create({
            name: "expired",
            expiresAt: Date.now() - 3600000,
          })

          const info = await ApiToken.validate(token)
          expect(info).toBeUndefined()
        },
      })
    },
    30_000,
  )

  test(
    "create with custom scopes",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { info } = await ApiToken.create({
            name: "read-only",
            scopes: ["read"],
          })

          expect(info.scopes).toEqual(["read"])
          expect(ApiToken.hasScope(info, "read")).toBe(true)
          expect(ApiToken.hasScope(info, "write")).toBe(false)
          expect(ApiToken.hasScope(info, "*")).toBe(false)
        },
      })
    },
    30_000,
  )

  test(
    "wildcard scope grants everything",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { info } = await ApiToken.create({ name: "admin" })

          expect(ApiToken.hasScope(info, "read")).toBe(true)
          expect(ApiToken.hasScope(info, "write")).toBe(true)
          expect(ApiToken.hasScope(info, "anything")).toBe(true)
        },
      })
    },
    30_000,
  )

  test(
    "list returns all tokens",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await ApiToken.create({ name: "token-a" })
          await ApiToken.create({ name: "token-b" })

          const tokens = ApiToken.list()
          expect(tokens.length).toBeGreaterThanOrEqual(2)

          const names = tokens.map((t) => t.name)
          expect(names).toContain("token-a")
          expect(names).toContain("token-b")
        },
      })
    },
    30_000,
  )

  test(
    "revoke deletes token",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { token, info } = await ApiToken.create({ name: "revoke-me" })

          // Should validate before revoke
          expect(await ApiToken.validate(token)).toBeDefined()

          ApiToken.revoke(info.id)

          // Should not validate after revoke
          expect(await ApiToken.validate(token)).toBeUndefined()
        },
      })
    },
    30_000,
  )

  test(
    "each token has unique hash",
    async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { token: t1 } = await ApiToken.create({ name: "unique-1" })
          const { token: t2 } = await ApiToken.create({ name: "unique-2" })

          expect(t1).not.toBe(t2)

          // Both should independently validate
          expect(await ApiToken.validate(t1)).toBeDefined()
          expect(await ApiToken.validate(t2)).toBeDefined()
        },
      })
    },
    30_000,
  )
})
