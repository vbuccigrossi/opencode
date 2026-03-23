import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission"
import { Auth } from "@/auth"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    permission?: PermissionNext.Ruleset
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = []
    const providerPrompt = input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)

    // Debug: log system prompt components for ollama
    if (input.model.providerID === "ollama" && !input.small) {
      log.info("ollama system prompt components", {
        providerPromptLen: providerPrompt.reduce((a, b) => a + b.length, 0),
        inputSystemCount: input.system.length,
        inputSystemLens: input.system.map((s) => s.length),
        inputSystemPreviews: input.system.map((s) => s.slice(0, 80)),
        userSystemLen: input.user.system?.length ?? 0,
      })
    }

    system.push(
      [
        ...providerPrompt,
        ...input.system,
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const tools = await resolveTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const name = failed.toolCall.toolName
        let repairedName = name
        let nameFixed = false

        // --- Phase 1: Repair tool name ---

        // try lowercase first
        if (name !== name.toLowerCase() && tools[name.toLowerCase()]) {
          repairedName = name.toLowerCase()
          nameFixed = true
        }
        if (!nameFixed) {
          // try stripping underscores/hyphens and case-insensitive match
          // handles todo_write -> todowrite, Web_Fetch -> webfetch, etc.
          const normalized = name.replace(/[-_]/g, "").toLowerCase()
          for (const toolName of Object.keys(tools)) {
            if (toolName.toLowerCase() === normalized) {
              repairedName = toolName
              nameFixed = true
              break
            }
          }
          if (!nameFixed) {
            // try alias lookup (config overrides builtins)
            const builtinAliases: Record<string, string> = {
              search: "grep",
              find: "glob",
              cat: "read",
              run: "bash",
              shell: "bash",
              todo: "todowrite",
              fetch: "webfetch",
            }
            const userAliases = cfg.experimental?.tool_aliases ?? {}
            const aliases = { ...builtinAliases, ...userAliases }
            const aliasTarget = aliases[name] ?? aliases[name.toLowerCase()] ?? aliases[normalized]
            if (aliasTarget && tools[aliasTarget]) {
              repairedName = aliasTarget
              nameFixed = true
            }
          }
        }

        // --- Phase 2: Repair argument field names ---
        // Local models often use wrong field names. Two-step repair:
        //   a) Common aliases (e.g. "path" → "file_path")
        //   b) snake_case → camelCase (e.g. "file_path" → "filePath")
        let repairedInput = failed.toolCall.input
        try {
          const parsed = JSON.parse(failed.toolCall.input)
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            // Step a: Fix common field name aliases that models hallucinate
            const fieldAliases: Record<string, string> = {
              path: "file_path",
              filepath: "file_path",
              filename: "file_path",
              file: "file_path",
              text: "content",
              body: "content",
              old: "old_string",
              new: "new_string",
              original: "old_string",
              replacement: "new_string",
              search: "pattern",
              query: "pattern",
              cmd: "command",
              shell: "command",
              glob: "pattern",
            }
            const aliased: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(parsed)) {
              const normalizedKey = key.toLowerCase().replace(/[-_]/g, "")
              const alias = fieldAliases[normalizedKey]
              aliased[alias ?? key] = value
            }

            // Step b: Convert snake_case to camelCase
            const converted: Record<string, unknown> = {}
            let didConvert = false
            for (const [key, value] of Object.entries(aliased)) {
              const camelKey = key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())
              if (camelKey !== key) didConvert = true
              converted[camelKey] = value
            }

            const inputKeys = Object.keys(parsed)
            const outputKeys = Object.keys(converted)
            if (didConvert || inputKeys.join(",") !== outputKeys.join(",")) {
              repairedInput = JSON.stringify(converted)
              l.info("repaired tool args", {
                tool: repairedName,
                original: inputKeys,
                converted: outputKeys,
              })
            }
          }
        } catch {
          // Input is not valid JSON — leave as-is
        }

        // If we fixed either the name or the args, return the repaired call
        const targetName = nameFixed ? repairedName : name
        if ((nameFixed || repairedInput !== failed.toolCall.input) && tools[targetName]) {
          l.info("repairing tool call", {
            tool: name,
            repaired: targetName,
            argsFixed: repairedInput !== failed.toolCall.input,
          })
          return { ...failed.toolCall, toolName: targetName, input: repairedInput }
        }

        // Nothing could be repaired — forward to invalid tool
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: name,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode") && {
          "x-opencode-project": Instance.project.id,
          "x-opencode-session": input.sessionID,
          "x-opencode-request": input.user.id,
          "x-opencode-client": Flag.CORTEX_CLIENT,
        }),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = PermissionNext.disabled(
      Object.keys(input.tools),
      PermissionNext.merge(input.agent.permission, input.permission ?? []),
    )
    for (const tool of Object.keys(input.tools)) {
      // Explicitly enabled tools (e.g. MCP tools granted to subagents) bypass
      // the agent-level disabled check so they remain available even when the
      // agent's default permission is "deny *".
      const explicitlyEnabled = input.user.tools?.[tool] === true
      if (input.user.tools?.[tool] === false || (disabled.has(tool) && !explicitlyEnabled)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
