import z from "zod"
import { Tool } from "./tool"

/**
 * Think tool — allows the agent to record internal reasoning
 * that persists across steps within a turn.
 *
 * Thoughts are stored as tool call inputs, which:
 * - Persist in the conversation history (LLM sees them on subsequent turns)
 * - Survive compaction (tool inputs are preserved, only outputs are cleared)
 * - Are collected by the Scratchpad module for consolidated system prompt injection
 *
 * Use cases:
 * - Planning multi-step edits before starting
 * - Tracking what's been done and what remains
 * - Recording hypotheses during debugging
 * - Breaking down complex problems into steps
 */
export const ThinkTool = Tool.define("think", {
  description: [
    "Use this tool to think and reason internally before taking action.",
    "Record your analysis, plans, hypotheses, and intermediate reasoning.",
    "Your thoughts persist across steps — use them to stay on track during complex tasks.",
    "",
    "Good uses:",
    "- Planning a multi-step edit before starting",
    "- Analyzing a bug and forming hypotheses",
    "- Tracking progress on a complex task",
    "- Deciding between approaches before committing",
    "",
    "This tool does not modify any files or have side effects.",
  ].join("\n"),
  parameters: z.object({
    thought: z.string().describe("Your internal reasoning, analysis, or plan"),
  }),
  async execute(params, ctx) {
    ctx.metadata({ title: "Thinking..." })
    return {
      title: "Thinking...",
      output: "Thought recorded.",
      metadata: {
        truncated: false,
      },
    }
  },
})
