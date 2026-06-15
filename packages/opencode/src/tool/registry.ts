import { PlanExitTool } from "./plan"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncate"

import { ApplyPatchTool } from "./apply_patch"
import { GraphTool } from "./graph"
import { VerifyTool } from "./verify"
import { ThinkTool } from "./think"
import { RememberTool } from "./remember"
import { DiffTool } from "./diff"
import { UndoTool } from "./undo"
import { WatchTool } from "./watch"
import { ReportTool } from "./report"
import { SecurityTool } from "./security"
import { SearchTool } from "./search"
import { GitTool } from "./git"
import { McpSearchTool } from "./mcp-search"
import { StateTool } from "./state"
import { SandboxTool } from "./sandbox"
import { ExploreTool } from "./explore"
import { RefactorTool } from "./refactor"
import { TestGenTool } from "./testgen"
import { DocsTool } from "./docs"
import { TuningTool } from "./tuning"
import { StagingTool } from "./staging"
import { CascadeTool } from "./cascade"
import { SystemTool } from "./system"
import { ContainerTool } from "./container"
import { ResearchTool } from "./research"
import { ChangesetTool } from "./changeset"
import { AlarmTool } from "./alarm"
import { ModelSwitchTool } from "./model_switch"
import { SemanticSearchTool } from "./semantic_search"
import { ScheduleTool } from "./schedule"
import { DeviceTool } from "./device"
import { TokenTool } from "./token"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  // OPT-1.1: Cache resolved tools keyed by (modelID, providerID, agentName)
  type ResolvedTool = Awaited<ReturnType<NonNullable<Tool.Info["init"]>>> & { id: string }
  const toolsCache = new Map<string, { result: ResolvedTool[]; timestamp: number }>()
  const TOOLS_CACHE_TTL = 60_000 // 1 minute — invalidated on register()

  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]

    const matches = await Config.directories().then((dirs) =>
      dirs.flatMap((dir) =>
        Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
      ),
    )
    if (matches.length) await Config.waitForDependencies()
    for (const match of matches) {
      const namespace = path.basename(match, path.extname(match))
      const mod = await import(process.platform === "win32" ? match : pathToFileURL(match).href)
      for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
        custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx = {
            ...ctx,
            directory: Instance.directory,
            worktree: Instance.worktree,
          } as unknown as PluginToolContext
          const result = await def.execute(args as any, pluginCtx)
          const out = await Truncate.output(result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
    } else {
      custom.push(tool)
    }
    // Invalidate tools cache when custom tools change
    toolsCache.clear()
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    const config = await Config.get()
    const question = ["app", "cli", "desktop"].includes(Flag.CORTEX_CLIENT) || Flag.CORTEX_ENABLE_QUESTION_TOOL

    return [
      InvalidTool,
      ...(question ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      WebFetchTool,
      TodoWriteTool,
      // TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      GraphTool,
      VerifyTool,
      ThinkTool,
      RememberTool,
      DiffTool,
      UndoTool,
      WatchTool,
      ReportTool,
      SecurityTool,
      SearchTool,
      GitTool,
      StateTool,
      SandboxTool,
      ExploreTool,
      RefactorTool,
      TestGenTool,
      DocsTool,
      TuningTool,
      StagingTool,
      CascadeTool,
      SystemTool,
      ContainerTool,
      ResearchTool,
      ChangesetTool,
      AlarmTool,
      ModelSwitchTool,
      SemanticSearchTool,
      ScheduleTool,
      DeviceTool,
      TokenTool,
      ...(Flag.CORTEX_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...(Flag.CORTEX_EXPERIMENTAL_PLAN_MODE && Flag.CORTEX_CLIENT === "cli" ? [PlanExitTool] : []),
      ...(config.experimental?.mcp_lazy === true ? [McpSearchTool] : []),
      ...custom,
    ]
  }

  export async function hasMcpSearch(): Promise<boolean> {
    const tools = await all()
    return tools.some((t) => t.id === "mcp_search")
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  export async function tools(
    model: {
      providerID: ProviderID
      modelID: ModelID
    },
    agent?: Agent.Info,
  ) {
    // OPT-1.1: Return cached tools if available and fresh
    const cacheKey = `${model.modelID}:${model.providerID}:${agent?.name ?? ""}`
    const cached = toolsCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < TOOLS_CACHE_TTL) {
      return cached.result
    }

    const tools = await all()
    const result = await Promise.all(
      tools
        .filter((t) => {
          // For ollama models, restrict to a curated tool set.
          // 32K context can handle ~15 tools comfortably.
          if (model.providerID === "ollama" as any) {
            const essentialTools = new Set([
              "read", "write", "edit", "bash", "think",
              "glob", "grep",
              "semantic_search", "diff",
            ])
            return essentialTools.has(t.id)
          }

          // Enable websearch/codesearch for zen users OR via enable flag
          if (t.id === "codesearch" || t.id === "websearch") {
            return model.providerID === ProviderID.opencode || Flag.CORTEX_ENABLE_EXA
          }

          // use apply tool in same format as codex
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)
          const tool = await t.init({ agent })
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          await Plugin.trigger("tool.definition", { toolID: t.id }, output)
          return {
            id: t.id,
            ...tool,
            description: output.description,
            parameters: output.parameters,
          }
        }),
    )

    // For ollama, compact tool descriptions to save context window tokens.
    // The full descriptions are designed for cloud models with 128K+ context.
    if (model.providerID === "ollama" as any) {
      for (const tool of result) {
        tool.description = compactDescription(tool.id, tool.description)
      }
    }

    // Cache the result
    toolsCache.set(cacheKey, { result, timestamp: Date.now() })
    return result
  }

  /** Compact descriptions for ollama to save context tokens. */
  const COMPACT_DESCRIPTIONS: Record<string, string> = {
    bash: `Run a shell command. Use for git, npm, docker, build tools, etc.
Do NOT use for file operations — use read/write/edit instead.
Quote paths with spaces. Commands time out after 2 minutes by default.`,
    read: `Read a file's contents. Returns file content with line numbers.
Use offset/limit for large files to read specific sections.`,
    write: `Create or overwrite a file. Provide the full file content.
Read the file first if it already exists.`,
    edit: `Replace text in an existing file. Provide old_string (exact match) and new_string.
The old_string must be unique in the file. Use replace_all for global replacements.`,
    think: `Use this tool to think through complex problems step by step.
Write your reasoning in the thought parameter. No side effects.
Always think FIRST before writing code on complex tasks.`,
    grep: `Search file contents by regex pattern. Returns matching file paths or content lines.
Use output_mode "content" to see matching lines with context.`,
    glob: `Find files by name/path pattern (e.g., "**/*.go", "src/**/*.ts").
Returns matching file paths sorted by modification time.`,
    semantic_search: `Search indexed documentation, code examples, and reference material.
Operations: search (natural language query), rag_status (check index), status (check provider).
Use this to find API docs, exploit templates, detection rule syntax, and CVE details.`,
    diff: `Show changes made to files. Use to review your edits before moving on.`,
  }

  function compactDescription(id: string, original: string): string {
    return COMPACT_DESCRIPTIONS[id] ?? original
  }
}
