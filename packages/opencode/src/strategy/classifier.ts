/**
 * Task classifier — analyzes user messages to determine the type of task
 * being requested, which drives strategy selection.
 *
 * Classification is heuristic-based (no LLM calls) for sub-millisecond
 * performance. Uses keyword matching and structural analysis.
 */
export namespace TaskClassifier {
  /** Types of tasks the agent handles. */
  export type TaskType =
    | "simple_edit"   // Change a few lines in 1-2 files
    | "bug_fix"       // Diagnose and fix a problem
    | "feature"       // Add new functionality
    | "refactor"      // Restructure existing code
    | "exploration"   // Understand code, answer questions
    | "test"          // Write or fix tests
    | "review"        // Code review, security audit

  /** Signal weights per task type — higher = stronger indicator. */
  interface TaskSignals {
    keywords: string[]
    /** Negative keywords that reduce this signal */
    antiKeywords?: string[]
    weight: number
  }

  /** Keyword patterns for each task type. */
  const SIGNALS: Record<TaskType, TaskSignals[]> = {
    simple_edit: [
      { keywords: ["rename", "change", "update", "replace", "modify", "set", "add line", "remove line", "swap"], weight: 1.0 },
      { keywords: ["typo", "spelling", "wording", "text"], weight: 0.8 },
    ],
    bug_fix: [
      { keywords: ["fix", "bug", "broken", "error", "crash", "fail", "wrong", "incorrect", "issue", "not working"], weight: 1.0 },
      { keywords: ["debug", "diagnose", "investigate", "trace", "reproduce"], weight: 0.9 },
      { keywords: ["exception", "stack trace", "segfault", "panic", "undefined"], weight: 0.7 },
    ],
    feature: [
      { keywords: ["add", "implement", "create", "build", "new", "feature", "support"], weight: 1.0 },
      { keywords: ["integrate", "connect", "hook up", "wire"], weight: 0.8 },
      { keywords: ["endpoint", "api", "component", "module", "service"], weight: 0.6 },
    ],
    refactor: [
      { keywords: ["refactor", "restructure", "reorganize", "extract", "split", "merge", "consolidate"], weight: 1.0 },
      { keywords: ["clean up", "simplify", "deduplicate", "dry", "abstract", "generalize"], weight: 0.9 },
      { keywords: ["move", "migrate", "convert", "transform"], weight: 0.7 },
    ],
    exploration: [
      { keywords: ["explain", "how does", "what is", "where is", "find", "show me", "understand"], weight: 1.0 },
      { keywords: ["why", "when", "which", "describe", "walk through", "trace"], weight: 0.8 },
      { keywords: ["architecture", "design", "flow", "diagram"], weight: 0.7 },
      { keywords: ["?"], weight: 0.3 }, // Questions often end with ?
    ],
    test: [
      { keywords: ["test", "spec", "coverage", "assert", "expect"], weight: 1.0 },
      { keywords: ["write tests", "add tests", "fix test", "failing test", "test case"], weight: 1.2 },
      { keywords: ["mock", "stub", "fixture", "snapshot"], weight: 0.7 },
    ],
    review: [
      { keywords: ["review", "audit", "check", "inspect", "analyze", "assess"], weight: 1.0 },
      { keywords: ["security", "vulnerability", "exploit", "injection", "xss"], weight: 0.9 },
      { keywords: ["code quality", "best practice", "pattern", "smell"], weight: 0.7 },
      { keywords: ["pr", "pull request", "diff", "changes"], weight: 0.6 },
    ],
  }

  /**
   * Classifies a user message into a task type.
   *
   * Scores each task type based on keyword matches in the message.
   * Falls back to "feature" for ambiguous cases.
   *
   * @param message - The user's message text
   * @returns The classified task type
   */
  export function classify(message: string): TaskType {
    const lower = message.toLowerCase()
    const scores: Record<TaskType, number> = {
      simple_edit: 0,
      bug_fix: 0,
      feature: 0,
      refactor: 0,
      exploration: 0,
      test: 0,
      review: 0,
    }

    for (const [taskType, signalGroups] of Object.entries(SIGNALS) as [TaskType, TaskSignals[]][]) {
      for (const signals of signalGroups) {
        for (const keyword of signals.keywords) {
          if (lower.includes(keyword)) {
            scores[taskType] += signals.weight
          }
        }
      }
    }

    // Structural signals
    if (lower.endsWith("?") || lower.startsWith("how") || lower.startsWith("what") || lower.startsWith("why")) {
      scores.exploration += 0.5
    }

    // Short messages are more likely simple edits
    if (message.length < 80 && scores.simple_edit > 0) {
      scores.simple_edit += 0.3
    }

    // Long messages with multiple files are likely features/refactors
    const fileRefs = (message.match(/[\w./]+\.(ts|tsx|js|jsx|py|go|rs)\b/g) ?? []).length
    if (fileRefs >= 3) {
      scores.refactor += 0.3
      scores.feature += 0.2
    }

    // Find highest scoring type
    let best: TaskType = "feature" // default fallback
    let bestScore = 0

    for (const [taskType, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score
        best = taskType as TaskType
      }
    }

    // If no signals fired, check for some basic patterns
    if (bestScore === 0) {
      if (lower.includes("?")) return "exploration"
      return "feature"
    }

    return best
  }

  /**
   * Returns confidence level (0-1) of the classification.
   * Higher when one type clearly dominates.
   *
   * @param message - User message text
   * @returns Confidence between 0 and 1
   */
  export function confidence(message: string): number {
    const lower = message.toLowerCase()
    const scores: number[] = []

    for (const [_, signalGroups] of Object.entries(SIGNALS) as [TaskType, TaskSignals[]][]) {
      let typeScore = 0
      for (const signals of signalGroups) {
        for (const keyword of signals.keywords) {
          if (lower.includes(keyword)) {
            typeScore += signals.weight
          }
        }
      }
      scores.push(typeScore)
    }

    const total = scores.reduce((a, b) => a + b, 0)
    if (total === 0) return 0

    const max = Math.max(...scores)
    return max / total
  }
}
