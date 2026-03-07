import z from "zod"
import { Tool } from "./tool"
import { Tuning } from "../tuning"

/**
 * Tuning tool — view adaptive session tuning state and adjustments.
 *
 * Operations:
 * - status: Show current tuning adjustments for the session
 * - history: Show tool history length
 * - clear: Clear tuning state for the session
 */
export const TuningTool = Tool.define("tuning", {
  description: `View adaptive session tuning status and adjustments.

Operations:
- status: Show current tuning adjustments (what the tuner recommends)
- history: Show how many tool uses have been recorded this session
- clear: Reset tuning state for this session

The tuning system automatically detects patterns like:
- Repeated search failures (suggests graph/explore instead of grep)
- Verification spirals (suggests stopping to think)
- Read fatigue (suggests making an edit instead of more research)
- Tool preference (suggests avoiding low-success-rate tools)`,
  parameters: z.object({
    operation: z
      .enum(["status", "history", "clear"])
      .describe("The tuning operation to perform"),
    session_id: z
      .string()
      .describe("Session ID to query"),
  }),
  async execute(params): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "status":
        return tuningStatus(params.session_id)
      case "history":
        return tuningHistory(params.session_id)
      case "clear":
        return tuningClear(params.session_id)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
})

function tuningStatus(sessionId: string) {
  const adjustments = Tuning.analyze(sessionId)
  if (adjustments.length === 0) {
    return {
      title: "tuning: no adjustments",
      metadata: { truncated: false, adjustmentCount: 0 },
      output: "No tuning adjustments detected. Tool usage patterns look normal.",
    }
  }

  const lines = adjustments.map((a) => {
    let line = `[${a.type}] ${a.reason} (priority: ${a.priority})`
    if (a.suggestion) line += `\n  → ${a.suggestion}`
    return line
  })

  return {
    title: `tuning: ${adjustments.length} adjustment(s)`,
    metadata: { truncated: false, adjustmentCount: adjustments.length },
    output: `${adjustments.length} tuning adjustment(s):\n${lines.join("\n")}`,
  }
}

function tuningHistory(sessionId: string) {
  const length = Tuning.historyLength(sessionId)
  return {
    title: `tuning: ${length} records`,
    metadata: { truncated: false, historyLength: length },
    output: `Session has ${length} tool use record(s) in tuning history.`,
  }
}

function tuningClear(sessionId: string) {
  Tuning.clear(sessionId)
  return {
    title: "tuning: cleared",
    metadata: { truncated: false },
    output: `Cleared tuning state for session ${sessionId}.`,
  }
}
