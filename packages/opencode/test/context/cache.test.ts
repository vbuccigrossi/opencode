import { describe, expect, test } from "bun:test"
import { ContextCache } from "../../src/context/cache"

describe("context.cache", () => {
  test("stores and retrieves cached context", () => {
    const sessionID = "test-session-1"
    const seedHash = ContextCache.hashSeeds(["UserService"], ["src/user.ts"])

    ContextCache.set(sessionID, seedHash, "<context>test</context>", 100)

    const cached = ContextCache.get(sessionID, seedHash)
    expect(cached).toBe("<context>test</context>")
  })

  test("returns undefined for cache miss", () => {
    const cached = ContextCache.get("nonexistent-session", "hash")
    expect(cached).toBeUndefined()
  })

  test("returns undefined when seed hash changes", () => {
    const sessionID = "test-session-2"
    const hash1 = ContextCache.hashSeeds(["A"], [])
    const hash2 = ContextCache.hashSeeds(["B"], [])

    ContextCache.set(sessionID, hash1, "context-a", 50)

    const cached = ContextCache.get(sessionID, hash2)
    expect(cached).toBeUndefined()
  })

  test("invalidateAll clears all entries", () => {
    const hash = ContextCache.hashSeeds(["X"], [])
    ContextCache.set("s1", hash, "ctx1", 10)
    ContextCache.set("s2", hash, "ctx2", 20)

    ContextCache.invalidateAll()

    expect(ContextCache.get("s1", hash)).toBeUndefined()
    expect(ContextCache.get("s2", hash)).toBeUndefined()
  })

  test("evict removes single session entry", () => {
    const hash = ContextCache.hashSeeds(["Y"], [])
    ContextCache.set("s3", hash, "ctx3", 10)
    ContextCache.set("s4", hash, "ctx4", 20)

    ContextCache.evict("s3")

    expect(ContextCache.get("s3", hash)).toBeUndefined()
    expect(ContextCache.get("s4", hash)).toBe("ctx4")

    // Cleanup
    ContextCache.invalidateAll()
  })

  test("hashSeeds produces consistent hashes", () => {
    const h1 = ContextCache.hashSeeds(["B", "A"], ["z.ts", "a.ts"])
    const h2 = ContextCache.hashSeeds(["A", "B"], ["a.ts", "z.ts"])
    // Should be the same since we sort
    expect(h1).toBe(h2)
  })

  test("hashSeeds produces different hashes for different inputs", () => {
    const h1 = ContextCache.hashSeeds(["A"], ["x.ts"])
    const h2 = ContextCache.hashSeeds(["B"], ["y.ts"])
    expect(h1).not.toBe(h2)
  })
})
