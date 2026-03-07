import { Log } from "@/util/log"

/**
 * Session-scoped query cache for expensive graph operations.
 *
 * Caches results of impactOf, callersOf, calleesOf, and relatedTests
 * to avoid repeated SQLite hits during a single prompt cycle.
 *
 * Invalidated on file edit events (registered in Graph.init()).
 */
export namespace GraphCache {
  const log = Log.create({ service: "graph.cache" })

  /** Cache TTL in milliseconds (5 minutes). */
  const TTL_MS = 5 * 60 * 1000

  interface CacheEntry {
    value: any
    timestamp: number
  }

  const cache = new Map<string, CacheEntry>()

  /**
   * Generates a cache key from a query type and arguments.
   *
   * @param projectID - Project scope
   * @param query - Query name (e.g., "callersOf")
   * @param args - Query arguments
   * @returns Cache key string
   */
  export function key(projectID: string, query: string, ...args: (string | number)[]): string {
    return `${projectID}:${query}:${args.join(":")}`
  }

  /**
   * Gets a cached value, or undefined if not cached or expired.
   *
   * @param cacheKey - The cache key
   * @returns Cached value, or undefined
   */
  export function get<T>(cacheKey: string): T | undefined {
    const entry = cache.get(cacheKey)
    if (!entry) return undefined
    if (Date.now() - entry.timestamp > TTL_MS) {
      cache.delete(cacheKey)
      return undefined
    }
    return entry.value as T
  }

  /**
   * Sets a cache entry.
   *
   * @param cacheKey - The cache key
   * @param value - The value to cache
   */
  export function set(cacheKey: string, value: any): void {
    cache.set(cacheKey, { value, timestamp: Date.now() })
  }

  /**
   * Invalidates all cache entries for a project.
   * Called when a file is edited.
   *
   * @param projectID - Project scope to invalidate
   */
  export function invalidate(projectID: string): void {
    const prefix = `${projectID}:`
    let cleared = 0
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) {
        cache.delete(k)
        cleared++
      }
    }
    if (cleared > 0) {
      log.info("cache invalidated", { projectID, cleared })
    }
  }

  /**
   * Clears the entire cache.
   */
  export function clear(): void {
    cache.clear()
  }

  /**
   * Returns cache statistics.
   */
  export function stats(): { size: number; expired: number } {
    const now = Date.now()
    let expired = 0
    for (const entry of cache.values()) {
      if (now - entry.timestamp > TTL_MS) expired++
    }
    return { size: cache.size, expired }
  }
}
