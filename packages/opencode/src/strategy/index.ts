import { Log } from "@/util/log"
import { TaskClassifier } from "./classifier"
import { Strategies } from "./strategies"

/**
 * Strategy engine — classifies tasks and selects appropriate behavioral
 * strategies to guide agent execution.
 *
 * The engine runs on step 1 to classify the user's request and inject
 * strategy guidance into the system prompt. The strategy influences:
 * - Whether to think before acting
 * - How to approach edits (direct vs staged vs cautious)
 * - When to verify and checkpoint
 *
 * Strategies are guidance, not constraints — the agent can deviate
 * when circumstances warrant it.
 */
export namespace Strategy {
  const log = Log.create({ service: "strategy" })

  /** Re-export task type for convenience. */
  export type TaskType = TaskClassifier.TaskType

  /** Per-session active strategy. */
  const activeStrategies = new Map<string, Strategies.Strategy>()

  /**
   * Classifies the user's message and selects a strategy.
   *
   * Called on step 1 of each session turn.
   *
   * @param sessionID - Session identifier
   * @param userMessage - The user's message text
   * @returns The selected strategy
   */
  export function select(sessionID: string, userMessage: string): Strategies.Strategy {
    const taskType = TaskClassifier.classify(userMessage)
    const strategy = Strategies.get(taskType)

    activeStrategies.set(sessionID, strategy)
    log.info("strategy selected", {
      sessionID: sessionID.slice(0, 8),
      taskType,
      strategyName: strategy.name,
      confidence: TaskClassifier.confidence(userMessage).toFixed(2),
    })

    return strategy
  }

  /**
   * Gets the currently active strategy for a session.
   *
   * @param sessionID - Session identifier
   * @returns Active strategy, or undefined if not yet classified
   */
  export function active(sessionID: string): Strategies.Strategy | undefined {
    return activeStrategies.get(sessionID)
  }

  /**
   * Switches to a different strategy mid-session.
   *
   * Used when the initial strategy isn't working (e.g., a "simple_edit"
   * turns out to need "refactor" treatment).
   *
   * @param sessionID - Session identifier
   * @param newType - The new task type to switch to
   * @returns The new strategy
   */
  export function switchStrategy(sessionID: string, newType: TaskClassifier.TaskType): Strategies.Strategy {
    const strategy = Strategies.get(newType)
    activeStrategies.set(sessionID, strategy)
    log.info("strategy switched", {
      sessionID: sessionID.slice(0, 8),
      newType,
      strategyName: strategy.name,
    })
    return strategy
  }

  /**
   * Gets the injection block for the current strategy.
   *
   * Returns the formatted `<strategy>` block if a strategy is active,
   * or empty string if not yet classified.
   *
   * @param sessionID - Session identifier
   * @returns Formatted strategy block or empty string
   */
  export function getInjection(sessionID: string): string {
    const strategy = activeStrategies.get(sessionID)
    if (!strategy) return ""
    return Strategies.format(strategy)
  }

  /**
   * Clears the active strategy for a session.
   *
   * @param sessionID - Session identifier
   */
  export function clear(sessionID: string): void {
    activeStrategies.delete(sessionID)
  }

  /**
   * Re-exports the classifier for direct use.
   */
  export const classify = TaskClassifier.classify
  export const classifyConfidence = TaskClassifier.confidence
}
