import { Bus } from "@/bus"
import { File } from "@/file"
import { Log } from "@/util/log"

/**
 * Caches context pipeline results per session.
 *
 * Invalidated when files change (via File.Event.Edited).
 * Prevents redundant graph queries and scoring on follow-up messages
 * within the same session when the codebase hasn't changed.
 */
export namespace ContextCache {
  const log = Log.create({ service: "context.cache" })

  interface CacheEntry {
    /** The cached context block text */
    contextBlock: string
    /** Timestamp when cached */
    timestamp: number
    /** Hash of the seed data used to generate this entry */
    seedHash: string
    /** Tokens used */
    tokensUsed: number
  }

  /** Session-scoped cache: sessionID → cache entry */
  const cache = new Map<string, CacheEntry>()

  /** Maximum age of a cache entry in ms (5 minutes) */
  const MAX_AGE_MS = 5 * 60 * 1000

  /**
   * Gets a cached context block if available and still valid.
   *
   * @param sessionID - Session scope
   * @param seedHash - Hash of current seed data for cache key comparison
   * @returns Cached context block, or undefined if cache miss
   */
  export function get(sessionID: string, seedHash: string): string | undefined {
    const entry = cache.get(sessionID)
    if (!entry) return undefined

    // Check if expired
    if (Date.now() - entry.timestamp > MAX_AGE_MS) {
      cache.delete(sessionID)
      return undefined
    }

    // Check if seeds changed (different user message)
    if (entry.seedHash !== seedHash) {
      return undefined
    }

    return entry.contextBlock
  }

  /**
   * Stores a context block in the cache.
   *
   * @param sessionID - Session scope
   * @param seedHash - Hash of the seed data
   * @param contextBlock - The context block text
   * @param tokensUsed - Tokens consumed by this block
   */
  export function set(
    sessionID: string,
    seedHash: string,
    contextBlock: string,
    tokensUsed: number,
  ): void {
    cache.set(sessionID, {
      contextBlock,
      timestamp: Date.now(),
      seedHash,
      tokensUsed,
    })
  }

  /**
   * Invalidates cache entries when files change.
   * Call this on File.Event.Edited to ensure stale context isn't served.
   */
  export function invalidateAll(): void {
    if (cache.size > 0) {
      cache.clear()
    }
  }

  /**
   * Removes cache entry for a specific session.
   *
   * @param sessionID - Session to evict
   */
  export function evict(sessionID: string): void {
    cache.delete(sessionID)
  }

  /**
   * Computes a simple hash for seed data to use as cache key.
   *
   * @param keywords - Seed keywords
   * @param filePaths - Seed file paths
   * @returns Hash string
   */
  export function hashSeeds(keywords: string[], filePaths: string[]): string {
    return [...keywords.sort(), "||", ...filePaths.sort()].join(",")
  }

  /**
   * Initializes cache invalidation on file changes.
   */
  export function init(): void {
    Bus.subscribe(File.Event.Edited, () => {
      invalidateAll()
    })
  }
}
