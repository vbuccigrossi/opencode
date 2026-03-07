import { describe, expect, test, beforeEach } from "bun:test"
import { GraphCache } from "../../src/graph/cache"

describe("graph.cache", () => {
  beforeEach(() => {
    GraphCache.clear()
  })

  test("generates consistent cache keys", () => {
    const k1 = GraphCache.key("proj1", "callersOf", "myFunc")
    const k2 = GraphCache.key("proj1", "callersOf", "myFunc")
    expect(k1).toBe(k2)
    expect(k1).toBe("proj1:callersOf:myFunc")
  })

  test("different queries produce different keys", () => {
    const k1 = GraphCache.key("proj1", "callersOf", "foo")
    const k2 = GraphCache.key("proj1", "calleesOf", "foo")
    expect(k1).not.toBe(k2)
  })

  test("stores and retrieves values", () => {
    GraphCache.set("test-key", [1, 2, 3])
    const result = GraphCache.get<number[]>("test-key")
    expect(result).toEqual([1, 2, 3])
  })

  test("returns undefined for missing keys", () => {
    expect(GraphCache.get("nonexistent")).toBeUndefined()
  })

  test("invalidates by project prefix", () => {
    GraphCache.set("proj1:callersOf:foo", [1])
    GraphCache.set("proj1:calleesOf:bar", [2])
    GraphCache.set("proj2:callersOf:foo", [3])

    GraphCache.invalidate("proj1")

    expect(GraphCache.get("proj1:callersOf:foo")).toBeUndefined()
    expect(GraphCache.get("proj1:calleesOf:bar")).toBeUndefined()
    expect(GraphCache.get<number[]>("proj2:callersOf:foo")).toEqual([3])
  })

  test("clear removes all entries", () => {
    GraphCache.set("a", 1)
    GraphCache.set("b", 2)
    GraphCache.clear()
    expect(GraphCache.get("a")).toBeUndefined()
    expect(GraphCache.get("b")).toBeUndefined()
  })

  test("stats reports cache size", () => {
    GraphCache.set("a", 1)
    GraphCache.set("b", 2)
    const s = GraphCache.stats()
    expect(s.size).toBe(2)
    expect(s.expired).toBe(0)
  })
})
