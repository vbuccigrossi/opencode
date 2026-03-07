import type { TaskClassifier } from "./classifier"

/**
 * Strategy definitions — behavioral hints that guide the agent's approach
 * based on the classified task type.
 *
 * Each strategy describes:
 * - How to approach edits (direct, staged, cautious)
 * - When to verify (after all, after each, after batch)
 * - Whether to checkpoint (never, auto, always)
 * - Whether to think before acting
 * - Pre-work steps to take
 *
 * Strategies are injected as guidance, not constraints. The agent can
 * deviate if circumstances warrant it.
 */
export namespace Strategies {
  /** Edit approach. */
  export type EditMode = "direct" | "staged" | "cautious"

  /** When to run verification. */
  export type VerifyFrequency = "after_all" | "after_each" | "after_batch"

  /** When to create checkpoints. */
  export type CheckpointPolicy = "never" | "auto" | "always"

  /** A complete strategy definition. */
  export interface Strategy {
    /** The task type this strategy applies to */
    type: TaskClassifier.TaskType
    /** Human-readable name */
    name: string
    /** Steps to take before main work */
    prelude: string[]
    /** How to approach edits */
    editMode: EditMode
    /** When to verify changes */
    verifyFrequency: VerifyFrequency
    /** When to create checkpoints */
    checkpointPolicy: CheckpointPolicy
    /** Whether to use think tool before acting */
    thinkFirst: boolean
    /** Number of files before creating a checkpoint */
    maxFilesBeforeCheckpoint: number
    /** Guidance text injected into system prompt */
    guidance: string
  }

  /** Built-in strategies for each task type. */
  const STRATEGIES: Record<TaskClassifier.TaskType, Strategy> = {
    simple_edit: {
      type: "simple_edit",
      name: "Quick Edit",
      prelude: ["Locate the target code"],
      editMode: "direct",
      verifyFrequency: "after_all",
      checkpointPolicy: "never",
      thinkFirst: false,
      maxFilesBeforeCheckpoint: Infinity,
      guidance: [
        "This is a simple, targeted change.",
        "- Make the edit directly without extensive analysis",
        "- Verify once after all changes are complete",
        "- No checkpoint needed for small changes",
      ].join("\n"),
    },

    bug_fix: {
      type: "bug_fix",
      name: "Bug Fix",
      prelude: [
        "Understand the expected behavior",
        "Reproduce the issue (read relevant code)",
        "Identify the root cause before editing",
      ],
      editMode: "direct",
      verifyFrequency: "after_each",
      checkpointPolicy: "auto",
      thinkFirst: true,
      maxFilesBeforeCheckpoint: 3,
      guidance: [
        "This is a bug fix. Diagnose before you edit.",
        "- Use the think tool to reason about the root cause",
        "- Read the failing code and its callers before making changes",
        "- Verify after each file edit to catch regressions early",
        "- If your first fix doesn't work, record it as a failed approach",
      ].join("\n"),
    },

    feature: {
      type: "feature",
      name: "Feature Implementation",
      prelude: [
        "Understand the requirements",
        "Identify affected files and interfaces",
        "Plan the implementation order",
      ],
      editMode: "staged",
      verifyFrequency: "after_batch",
      checkpointPolicy: "auto",
      thinkFirst: true,
      maxFilesBeforeCheckpoint: 3,
      guidance: [
        "This is a feature implementation. Plan before building.",
        "- Initialize state with a goal and plan",
        "- Implement in stages: core logic first, then integration, then tests",
        "- Verify after completing each stage (batch of related changes)",
        "- Create checkpoints before risky changes",
      ].join("\n"),
    },

    refactor: {
      type: "refactor",
      name: "Refactoring",
      prelude: [
        "Understand the current structure",
        "Identify all references and callers",
        "Plan the refactoring steps",
        "Create a checkpoint before starting",
      ],
      editMode: "cautious",
      verifyFrequency: "after_each",
      checkpointPolicy: "always",
      thinkFirst: true,
      maxFilesBeforeCheckpoint: 2,
      guidance: [
        "This is a refactoring task. Move carefully.",
        "- Always create a checkpoint before starting",
        "- Use the graph to find all callers and references",
        "- Verify after each file change to catch type errors immediately",
        "- If verification fails, consider rolling back to checkpoint",
        "- Update tests alongside the code changes",
      ].join("\n"),
    },

    exploration: {
      type: "exploration",
      name: "Code Exploration",
      prelude: [
        "Identify what the user wants to understand",
        "Find the relevant code paths",
      ],
      editMode: "direct",
      verifyFrequency: "after_all",
      checkpointPolicy: "never",
      thinkFirst: true,
      maxFilesBeforeCheckpoint: Infinity,
      guidance: [
        "This is an exploration/understanding task.",
        "- Focus on reading and explaining, not editing",
        "- Use the graph to trace code paths and relationships",
        "- Be thorough but concise in explanations",
        "- Only make edits if the user explicitly asks",
      ].join("\n"),
    },

    test: {
      type: "test",
      name: "Test Writing",
      prelude: [
        "Read the code under test",
        "Understand the expected behavior",
      ],
      editMode: "direct",
      verifyFrequency: "after_all",
      checkpointPolicy: "auto",
      thinkFirst: false,
      maxFilesBeforeCheckpoint: 5,
      guidance: [
        "This is a testing task.",
        "- Read the implementation before writing tests",
        "- Cover happy paths, edge cases, and error conditions",
        "- Run tests after writing to verify they pass",
        "- If tests fail, fix the test first (not the implementation) unless the implementation has a real bug",
      ].join("\n"),
    },

    review: {
      type: "review",
      name: "Code Review",
      prelude: [
        "Read the code being reviewed",
        "Understand the context and purpose",
      ],
      editMode: "direct",
      verifyFrequency: "after_all",
      checkpointPolicy: "never",
      thinkFirst: true,
      maxFilesBeforeCheckpoint: Infinity,
      guidance: [
        "This is a code review/audit task.",
        "- Focus on reading and analyzing, not editing",
        "- Use the think tool to organize findings",
        "- Check for: correctness, security, performance, maintainability",
        "- Only make edits if explicitly asked to fix issues",
      ].join("\n"),
    },
  }

  /**
   * Gets the strategy for a task type.
   *
   * @param taskType - The classified task type
   * @returns The corresponding strategy
   */
  export function get(taskType: TaskClassifier.TaskType): Strategy {
    return STRATEGIES[taskType]
  }

  /**
   * Gets all available strategies.
   *
   * @returns All strategy definitions
   */
  export function all(): Strategy[] {
    return Object.values(STRATEGIES)
  }

  /**
   * Formats a strategy as a compact `<strategy>` block for system prompt injection.
   *
   * @param strategy - The strategy to format
   * @returns Formatted XML block
   */
  export function format(strategy: Strategy): string {
    const lines: string[] = []
    lines.push(`Strategy: ${strategy.name} (${strategy.type})`)
    lines.push(`Edit mode: ${strategy.editMode} | Verify: ${strategy.verifyFrequency} | Checkpoint: ${strategy.checkpointPolicy}`)
    if (strategy.thinkFirst) {
      lines.push("Think before acting: yes")
    }
    lines.push("")
    lines.push(strategy.guidance)

    return `<strategy>\n${lines.join("\n")}\n</strategy>`
  }
}
