import z from "zod"
import { Tool } from "./tool"
import { ModelAlias } from "../model/aliases"
import { Log } from "../util/log"

/**
 * Model switch tool — change the active model mid-conversation using aliases or full IDs.
 *
 * Supports quick aliases like "fast", "smart", "code" as well as full
 * provider/model IDs like "anthropic/claude-sonnet-4-6".
 */
export const ModelSwitchTool = Tool.define("model_switch", async () => ({
  description: `Switch the active model mid-conversation using aliases or full model IDs.

Operations:
- switch: Change to a different model (by alias or full ID)
- aliases: List all available model aliases
- current: Show the currently active model

Quick aliases (examples):
- "fast" / "quick" / "cheap" → Claude Haiku (fastest, cheapest)
- "smart" / "best" → Claude Opus (most capable)
- "code" / "balanced" / "default" → Claude Sonnet (balanced)
- "gpt" → GPT-4.1
- "gemini" → Gemini 2.5 Pro
- "flash" → Gemini 2.5 Flash

Users can define custom aliases in config under "model_aliases".
Full provider/model IDs (e.g. "anthropic/claude-sonnet-4-6") also work.`,
  parameters: z.object({
    operation: z
      .enum(["switch", "aliases", "current"])
      .describe("The operation to perform"),
    model: z
      .string()
      .optional()
      .describe('Model alias or full provider/model ID (required for switch). E.g. "fast", "smart", "anthropic/claude-opus-4-6"'),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "switch":
        return modelSwitch(params.model, ctx)
      case "aliases":
        return modelAliases()
      case "current":
        return modelCurrent(ctx)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.model_switch" })

/**
 * Switch to a different model.
 *
 * @param model - Alias or full model ID
 * @param ctx - Tool context
 * @returns Tool result confirming the switch
 */
async function modelSwitch(
  model: string | undefined,
  ctx: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!model) throw new Error("model parameter is required for switch operation")

  const isAlias = await ModelAlias.isAlias(model)
  const resolved = await ModelAlias.resolve(model)

  // Validate format: should be provider/model
  if (!resolved.includes("/")) {
    throw new Error(
      `Invalid model format: "${resolved}". Expected format: "provider/model" (e.g. "anthropic/claude-sonnet-4-6"). Use the "aliases" operation to see available shortcuts.`,
    )
  }

  const [providerID, modelID] = resolved.split("/", 2)

  // Store the switch request in metadata for the session to pick up
  // The actual model switch is handled by the session layer reading this metadata
  const aliasNote = isAlias ? ` (alias: "${model}")` : ""

  return {
    title: `model: switch to ${modelID}`,
    metadata: {
      modelSwitch: true,
      providerID,
      modelID,
      resolved,
      alias: isAlias ? model : undefined,
    },
    output: `Model switch requested: ${resolved}${aliasNote}\n\nThe model will be used for subsequent messages in this session. Note: the switch takes effect on the next message from the assistant.`,
  }
}

/**
 * List all available model aliases.
 *
 * @returns Tool result with alias listing
 */
async function modelAliases(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const all = await ModelAlias.list()

  // Group by target model
  const byModel = new Map<string, string[]>()
  for (const [alias, model] of Object.entries(all)) {
    const existing = byModel.get(model) ?? []
    existing.push(alias)
    byModel.set(model, existing)
  }

  const lines: string[] = []
  for (const [model, aliases] of byModel) {
    lines.push(`  ${aliases.join(", ")} → ${model}`)
  }
  lines.sort()

  return {
    title: "model: aliases",
    metadata: { count: Object.keys(all).length },
    output: `${Object.keys(all).length} model aliases available:\n\n${lines.join("\n")}\n\nTo add custom aliases, set "model_aliases" in your opencode config:\n  "model_aliases": { "my-alias": "provider/model-id" }`,
  }
}

/**
 * Show the currently active model.
 *
 * @param ctx - Tool context
 * @returns Tool result with current model info
 */
function modelCurrent(
  ctx: Tool.Context,
): { title: string; metadata: Record<string, any>; output: string } {
  // The current model is available through the session context
  // We report what we can access from the tool context
  return {
    title: "model: current",
    metadata: { agent: ctx.agent },
    output: `Current agent: ${ctx.agent}\n\nTo see the exact model, check the session header in the TUI or use the model selector (Ctrl+X, M).\nTo switch models, use the "switch" operation with an alias or full model ID.`,
  }
}
