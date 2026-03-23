import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID } from "@/session/schema"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_SCHEDULE from "./template/schedule.txt"
import PROMPT_DEVICE from "./template/device.txt"
import PROMPT_TOKEN from "./template/token.txt"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { executeSchedule, executeDevice, executeToken } from "./execute"

export namespace Command {
  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: SessionID.zod,
        arguments: z.string(),
        messageID: MessageID.zod,
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      source: z.enum(["command", "mcp", "skill"]).optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      subtask: z.boolean().optional(),
      hints: z.array(z.string()),
      help: z.string().optional(),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template"> & {
    template: Promise<string> | string
    /** Direct execution handler — bypasses the model entirely. */
    execute?: (args: string) => Promise<string>
  }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  export const Default = {
    INIT: "init",
    REVIEW: "review",
    SCHEDULE: "schedule",
    DEVICE: "device",
    TOKEN: "token",
  } as const

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      },
      [Default.SCHEDULE]: {
        name: Default.SCHEDULE,
        description: "manage scheduled tasks [list|create|delete|trigger|update]",
        source: "command",
        get template() {
          return PROMPT_SCHEDULE
        },
        execute: executeSchedule,
        hints: hints(PROMPT_SCHEDULE),
        help: [
          "/schedule — manage scheduled tasks",
          "",
          "Usage:",
          "  /schedule list                      List all scheduled tasks",
          "  /schedule create <name> <cron> <prompt>  Create a new task",
          "  /schedule delete <id>               Delete a task",
          "  /schedule trigger <id>              Run a task immediately",
          "  /schedule update <id> ...            Update a task",
          "  /schedule enable <id>               Enable a task",
          "  /schedule disable <id>              Disable a task",
          "",
          "Examples:",
          '  /schedule create daily-check "0 9 * * *" run all tests and report failures',
          '  /schedule create weekly-report "0 0 * * 1" generate a status report',
          "  /schedule list",
          "  /schedule trigger schedule_abc123",
        ].join("\n"),
      },
      [Default.DEVICE]: {
        name: Default.DEVICE,
        description: "manage devices for multi-device sync [list|register|remove|sync]",
        source: "command",
        get template() {
          return PROMPT_DEVICE
        },
        execute: executeDevice,
        hints: hints(PROMPT_DEVICE),
        help: [
          "/device — manage registered devices for multi-device sync",
          "",
          "Usage:",
          "  /device list                        List all registered devices",
          "  /device register <name> [type]      Register a new device",
          "  /device remove <id>                 Remove a device",
          "  /device sync <id>                   Sync a device (show pending events)",
          "  /device update <id> ...             Update device settings",
          "",
          "Examples:",
          "  /device register my-phone phone",
          '  /device register laptop laptop --push-url "https://example.com/hook"',
          "  /device sync dev_abc123",
          "  /device list",
        ].join("\n"),
      },
      [Default.TOKEN]: {
        name: Default.TOKEN,
        description: "manage API tokens [list|create|revoke]",
        source: "command",
        get template() {
          return PROMPT_TOKEN
        },
        execute: executeToken,
        hints: hints(PROMPT_TOKEN),
        help: [
          "/token — manage API tokens for external client authentication",
          "",
          "Usage:",
          "  /token list                         List all API tokens",
          "  /token create <name> [scopes]       Create a new token (shown once!)",
          "  /token revoke <id>                  Revoke a token",
          "",
          "Examples:",
          "  /token create my-api-key",
          '  /token create ci-token --scopes "schedule:read,session:write"',
          "  /token create temp-key --expires 24h",
          "  /token revoke tok_abc123",
        ].join("\n"),
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        source: "command",
        get template() {
          return command.template
        },
        subtask: command.subtask,
        hints: hints(command.template),
      }
    }
    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      result[name] = {
        name,
        source: "mcp",
        description: prompt.description,
        get template() {
          // since a getter can't be async we need to manually return a promise here
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? // substitute each argument with $1, $2, etc.
                  Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).catch(reject)
            resolve(
              template?.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          })
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      }
    }

    // Add skills as invokable commands
    for (const skill of await Skill.all()) {
      // Skip if a command with this name already exists
      if (result[skill.name]) continue
      result[skill.name] = {
        name: skill.name,
        description: skill.description,
        source: "skill",
        get template() {
          return skill.content
        },
        hints: [],
      }
    }

    return result
  })

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }
}
