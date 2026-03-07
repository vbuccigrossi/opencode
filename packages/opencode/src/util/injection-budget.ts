import { Log } from "./log"

/**
 * Coordinates injection budgets across the context pipeline, memory,
 * and scratchpad to prevent them from collectively consuming too much
 * of the model's context window.
 *
 * Budget allocation:
 * - Total injection budget = 15% of model context window
 * - Context pipeline: 40% of budget
 * - Memory: 25% of budget
 * - Scratchpad: 25% of budget
 * - Reserve: 10% of budget
 *
 * When a component has nothing to inject, its share is redistributed
 * to the others proportionally.
 */
export namespace InjectionBudget {
  const log = Log.create({ service: "injection-budget" })

  /** How the total injection budget is split across systems. */
  const ALLOCATION = {
    context: 0.4,
    memory: 0.25,
    scratchpad: 0.25,
    reserve: 0.1,
  } as const

  /** Fraction of model context window allocated to injections. */
  const INJECTION_FRACTION = 0.15

  /** Minimum budget per component (chars), to avoid starving any system. */
  const MIN_BUDGET_CHARS = 1000

  /** Fallback context window size when model info unavailable. */
  const DEFAULT_CONTEXT_WINDOW = 128_000

  /** Default chars-per-token ratio for budget calculations. */
  const CHARS_PER_TOKEN = 4

  // OPT-1.3: Memoize by (contextWindow, available flags) — only a few distinct values
  const budgetCache = new Map<string, Budget>()

  /** Computed budgets for each injection system. */
  export interface Budget {
    /** Context pipeline budget (tokens) */
    contextTokens: number
    /** Memory budget (chars) */
    memoryChars: number
    /** Memory budget (max entries) */
    memoryMaxEntries: number
    /** Scratchpad budget (chars) */
    scratchpadChars: number
    /** Scratchpad budget (max thoughts) */
    scratchpadMaxThoughts: number
    /** Total injection budget (tokens) */
    totalTokens: number
    /** Model context window (tokens) */
    contextWindow: number
  }

  /**
   * Computes injection budgets based on model context window.
   *
   * @param contextWindow - Model's total context window in tokens (default: 128k)
   * @param available - Which systems have content to inject
   * @returns Computed budgets for each system
   */
  export function compute(
    contextWindow?: number,
    available?: { context?: boolean; memory?: boolean; scratchpad?: boolean },
  ): Budget {
    const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW

    // OPT-1.3: Return memoized result if same inputs
    const cacheKey = `${window}:${available?.context !== false}:${available?.memory !== false}:${available?.scratchpad !== false}`
    const cached = budgetCache.get(cacheKey)
    if (cached) return cached

    const totalTokens = Math.floor(window * INJECTION_FRACTION)

    // Determine which systems need budget
    const hasContext = available?.context !== false
    const hasMemory = available?.memory !== false
    const hasScratchpad = available?.scratchpad !== false

    // Calculate redistribution
    let contextShare = hasContext ? ALLOCATION.context : 0
    let memoryShare = hasMemory ? ALLOCATION.memory : 0
    let scratchpadShare = hasScratchpad ? ALLOCATION.scratchpad : 0
    const reserveShare = ALLOCATION.reserve

    // Redistribute unused shares proportionally
    const usedShare = contextShare + memoryShare + scratchpadShare + reserveShare
    const unusedShare = 1 - usedShare
    if (unusedShare > 0 && usedShare > reserveShare) {
      const activeTotal = contextShare + memoryShare + scratchpadShare
      if (activeTotal > 0) {
        contextShare += unusedShare * (contextShare / activeTotal)
        memoryShare += unusedShare * (memoryShare / activeTotal)
        scratchpadShare += unusedShare * (scratchpadShare / activeTotal)
      }
    }

    // Context budget in tokens
    const contextTokens = Math.max(
      Math.floor(MIN_BUDGET_CHARS / CHARS_PER_TOKEN),
      Math.floor(totalTokens * contextShare),
    )

    // Memory budget in chars (with entry limit scaling)
    const memoryChars = Math.max(MIN_BUDGET_CHARS, Math.floor(totalTokens * memoryShare * CHARS_PER_TOKEN))
    const memoryMaxEntries = scaleEntries(window, 15, 30, 50)

    // Scratchpad budget in chars (with thought limit scaling)
    const scratchpadChars = Math.max(MIN_BUDGET_CHARS, Math.floor(totalTokens * scratchpadShare * CHARS_PER_TOKEN))
    const scratchpadMaxThoughts = scaleThoughts(window)

    log.info("injection budget computed", {
      contextWindow: window,
      totalTokens,
      contextTokens,
      memoryChars,
      memoryMaxEntries,
      scratchpadChars,
      scratchpadMaxThoughts,
    })

    const budget: Budget = {
      contextTokens,
      memoryChars,
      memoryMaxEntries,
      scratchpadChars,
      scratchpadMaxThoughts,
      totalTokens,
      contextWindow: window,
    }

    // OPT-1.3: Memoize
    budgetCache.set(cacheKey, budget)
    return budget
  }

  /**
   * Scales scratchpad thought limits based on context window.
   * - < 32k: 10 thoughts
   * - 32k-128k: 20 thoughts
   * - > 128k: 30 thoughts
   */
  function scaleThoughts(contextWindow: number): number {
    if (contextWindow < 32_000) return 10
    if (contextWindow <= 128_000) return 20
    return 30
  }

  /**
   * Scales memory entry limits based on context window.
   *
   * @param contextWindow - Context window size in tokens
   * @param small - Max entries for small windows (< 32k)
   * @param medium - Max entries for medium windows (32k-128k)
   * @param large - Max entries for large windows (> 128k)
   */
  function scaleEntries(contextWindow: number, small: number, medium: number, large: number): number {
    if (contextWindow < 32_000) return small
    if (contextWindow <= 128_000) return medium
    return large
  }
}
