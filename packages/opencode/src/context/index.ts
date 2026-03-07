import { ContextPipeline } from "./pipeline"
import { ContextCache } from "./cache"
import { Scorer } from "./scorer"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

/**
 * Advanced context selection module.
 *
 * Provides intelligent context packing for the LLM prompt. Instead of
 * sending entire files, this module scores code entities by relevance
 * and packs the highest-signal snippets within a token budget.
 *
 * Usage:
 * ```
 * const result = await Context.forMessage(userText, sessionID, recentFiles)
 * // result.contextBlock → inject into system prompt
 * ```
 */
export namespace Context {
  const log = Log.create({ service: "context" })

  export type Config = ContextPipeline.Config
  export type Result = ContextPipeline.Result

  /**
   * Generates a context block for a user message.
   *
   * Runs the multi-stage relevance pipeline:
   *   1. Extract seeds (keywords, file paths) from the message
   *   2. Score all graph entities by relevance
   *   3. Pack top candidates into a token-budgeted context block
   *
   * Results are cached per session and invalidated on file changes.
   *
   * @param userText - The user's message text
   * @param sessionID - Session ID for caching
   * @param recentFiles - Files recently accessed in this session
   * @param config - Optional pipeline configuration overrides
   * @returns Pipeline result with contextBlock to inject into system prompt
   */
  export async function forMessage(
    userText: string,
    sessionID: string,
    recentFiles: string[] = [],
    config: Partial<Config> = {},
  ): Promise<Result> {
    const projectID = Instance.project.id

    // Check cache
    const seeds = Scorer.extractSeeds(userText)
    const seedHash = ContextCache.hashSeeds(seeds.keywords, seeds.filePaths)
    const cached = ContextCache.get(sessionID, seedHash)
    if (cached !== undefined) {
      return {
        contextBlock: cached,
        candidatesScored: -1,
        entriesPacked: -1,
        tokensUsed: -1,
        durationMs: 0,
      }
    }

    // Run pipeline
    const result = await ContextPipeline.run(userText, projectID, recentFiles, config)

    // Cache result
    if (result.contextBlock) {
      ContextCache.set(sessionID, seedHash, result.contextBlock, result.tokensUsed)
    }

    return result
  }

  /**
   * Initializes the context module.
   *
   * Sets up cache invalidation on file changes.
   */
  export function init(): void {
    ContextCache.init()
    log.info("context pipeline initialized")
  }
}
