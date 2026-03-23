import { Schedule } from "../schedule"
import { Scheduler } from "../schedule/scheduler"
import { Device } from "../device"
import { DeviceSync } from "../device/sync"
import { ApiToken } from "../auth/token"
import { Instance } from "../project/instance"

/**
 * Direct execution handlers for slash commands.
 * These bypass the model and execute operations immediately.
 */

// ── Schedule ──

function formatTask(task: Schedule.Info): string {
  const status = task.enabled ? "enabled" : "disabled"
  const lastRun = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : "never"
  const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "none"
  const lines = [
    `**${task.name}** (${status})`,
    `ID: \`${task.id}\``,
    `Cron: \`${task.cron}\` (${Schedule.describeCron(task.cron)})`,
    `Prompt: ${task.prompt.length > 120 ? task.prompt.slice(0, 120) + "..." : task.prompt}`,
    `Delivery: ${typeof task.delivery === "object" ? task.delivery.type : "session"}`,
    `Last run: ${lastRun}${task.lastStatus ? ` (${task.lastStatus})` : ""}`,
    `Next run: ${nextRun}`,
  ]
  if (task.agent) lines.push(`Agent: ${task.agent}`)
  if (task.model) lines.push(`Model: ${task.model}`)
  if (task.lastError) lines.push(`Last error: ${task.lastError}`)
  return lines.join("\n")
}

export async function executeSchedule(args: string): Promise<string> {
  const parts = parseArgs(args)
  const sub = parts[0]?.toLowerCase() ?? "list"

  switch (sub) {
    case "list":
    case "ls": {
      const tasks = Schedule.list(Instance.project.id)
      if (tasks.length === 0) return "No scheduled tasks."
      return tasks.map(formatTask).join("\n\n---\n\n")
    }

    case "create":
    case "add": {
      const name = parts[1]
      const cron = parts[2]
      const prompt = parts.slice(3).join(" ")
      if (!name) return "Usage: /schedule create <name> <cron> <prompt>"
      if (!cron) return "Usage: /schedule create <name> <cron> <prompt>"
      if (!prompt) return "Usage: /schedule create <name> <cron> <prompt>"

      const cronErr = Schedule.validateCron(cron)
      if (cronErr) return `Invalid cron expression \`${cron}\`: ${cronErr}`

      const task = Schedule.create({ name, cron, prompt })
      return `Task created.\n\n${formatTask(task)}`
    }

    case "delete":
    case "remove":
    case "rm": {
      const id = parts[1]
      if (!id) return "Usage: /schedule delete <id>"
      const task = Schedule.get(id)
      if (!task) return `Task \`${id}\` not found.`
      Schedule.remove(id)
      return `Deleted task "${task.name}" (\`${id}\`).`
    }

    case "trigger":
    case "run": {
      const id = parts[1]
      if (!id) return "Usage: /schedule trigger <id>"
      const task = Schedule.get(id)
      if (!task) return `Task \`${id}\` not found.`
      const result = await Scheduler.triggerNow(id)
      if (!result.ok) return `Failed to trigger "${task.name}": ${result.error}`
      return `Triggered task "${task.name}" (\`${id}\`). Execution started.`
    }

    case "enable": {
      const id = parts[1]
      if (!id) return "Usage: /schedule enable <id>"
      const task = Schedule.get(id)
      if (!task) return `Task \`${id}\` not found.`
      Schedule.update({ id, enabled: true })
      return `Enabled task "${task.name}".`
    }

    case "disable": {
      const id = parts[1]
      if (!id) return "Usage: /schedule disable <id>"
      const task = Schedule.get(id)
      if (!task) return `Task \`${id}\` not found.`
      Schedule.update({ id, enabled: false })
      return `Disabled task "${task.name}".`
    }

    case "get":
    case "info":
    case "show": {
      const id = parts[1]
      if (!id) return "Usage: /schedule get <id>"
      const task = Schedule.get(id)
      if (!task) return `Task \`${id}\` not found.`
      return formatTask(task)
    }

    default:
      return `Unknown subcommand: ${sub}\nAvailable: list, create, delete, trigger, enable, disable, get, help`
  }
}

// ── Device ──

function formatDevice(d: Device.Info): string {
  const lastSync = d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : "never"
  return [
    `**${d.name}** (${d.type})`,
    `ID: \`${d.id}\``,
    `Push: ${d.pushUrl ?? "disabled"}`,
    `Events: ${d.pushEvents.join(", ")}`,
    `Last sync: ${lastSync} | Seq: ${d.lastSeenSeq}`,
  ].join("\n")
}

export async function executeDevice(args: string): Promise<string> {
  const parts = parseArgs(args)
  const sub = parts[0]?.toLowerCase() ?? "list"

  switch (sub) {
    case "list":
    case "ls": {
      const devices = Device.list()
      if (devices.length === 0) return "No registered devices."
      return devices.map(formatDevice).join("\n\n---\n\n")
    }

    case "register":
    case "add": {
      const name = parts[1]
      const type = parts[2]
      if (!name) return "Usage: /device register <name> [type]"
      const device = Device.register({ name, type })
      return `Device registered.\n\n${formatDevice(device)}`
    }

    case "remove":
    case "rm":
    case "delete": {
      const id = parts[1]
      if (!id) return "Usage: /device remove <id>"
      const device = Device.get(id)
      if (!device) return `Device \`${id}\` not found.`
      Device.remove(id)
      return `Removed device "${device.name}" (\`${id}\`).`
    }

    case "sync": {
      const id = parts[1]
      if (!id) return "Usage: /device sync <id>"
      const device = Device.get(id)
      if (!device) return `Device \`${id}\` not found.`

      const result = DeviceSync.sync({ deviceID: id, includeSessions: true })
      const lines = [
        `Synced device "${device.name}"`,
        `Events: ${result.events.length} | Pending: ${result.pending} | Seq: ${result.latestSeq}`,
      ]
      if (result.sessions) lines.push(`Sessions: ${result.sessions.length}`)
      if (result.events.length > 0) {
        lines.push("", "Recent events:")
        for (const e of result.events.slice(0, 15)) {
          lines.push(`  [${e.seq}] ${e.type} (${new Date(e.timeCreated).toLocaleTimeString()})`)
        }
        if (result.events.length > 15) lines.push(`  ... and ${result.events.length - 15} more`)
      }
      return lines.join("\n")
    }

    case "get":
    case "info":
    case "show": {
      const id = parts[1]
      if (!id) return "Usage: /device get <id>"
      const device = Device.get(id)
      if (!device) return `Device \`${id}\` not found.`
      return formatDevice(device)
    }

    default:
      return `Unknown subcommand: ${sub}\nAvailable: list, register, remove, sync, get, help`
  }
}

// ── Token ──

function formatTokenInfo(t: ApiToken.Info): string {
  const lastUsed = t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"
  const expires = t.expiresAt ? new Date(t.expiresAt).toLocaleString() : "never"
  return [
    `**${t.name}**`,
    `ID: \`${t.id}\` | Prefix: \`${t.prefix}...\``,
    `Scopes: ${t.scopes.join(", ")}`,
    `Last used: ${lastUsed} | Expires: ${expires}`,
  ].join("\n")
}

export async function executeToken(args: string): Promise<string> {
  const parts = parseArgs(args)
  const sub = parts[0]?.toLowerCase() ?? "list"

  switch (sub) {
    case "list":
    case "ls": {
      const tokens = ApiToken.list()
      if (tokens.length === 0) return "No API tokens."
      return tokens.map(formatTokenInfo).join("\n\n---\n\n")
    }

    case "create":
    case "add": {
      const name = parts[1]
      if (!name) return "Usage: /token create <name>"

      // Parse optional flags
      let scopes: string[] | undefined
      let expiresAt: number | undefined
      for (let i = 2; i < parts.length; i++) {
        if (parts[i] === "--scopes" && parts[i + 1]) {
          scopes = parts[i + 1].split(",").map((s) => s.trim())
          i++
        } else if (parts[i] === "--expires" && parts[i + 1]) {
          const hours = parseExpiry(parts[i + 1])
          if (hours) expiresAt = Date.now() + hours * 60 * 60 * 1000
          i++
        }
      }

      const { token, info } = await ApiToken.create({ name, scopes, expiresAt })
      return [
        "Token created.",
        "",
        "**Save this token now — it cannot be retrieved later:**",
        "",
        `\`${token}\``,
        "",
        "Usage:",
        `\`\`\``,
        `curl -H "Authorization: Bearer ${token}" http://localhost:3000/...`,
        `\`\`\``,
        "",
        formatTokenInfo(info),
      ].join("\n")
    }

    case "revoke":
    case "rm":
    case "delete": {
      const id = parts[1]
      if (!id) return "Usage: /token revoke <id>"
      const tokens = ApiToken.list()
      const existing = tokens.find((t) => t.id === id)
      if (!existing) return `Token \`${id}\` not found.`
      ApiToken.revoke(id)
      return `Revoked token "${existing.name}" (\`${id}\`).`
    }

    default:
      return `Unknown subcommand: ${sub}\nAvailable: list, create, revoke, help`
  }
}

// ── Utilities ──

/**
 * Parse arguments respecting quoted strings.
 * "foo bar" → ["foo", "bar"]
 * 'foo "bar baz" qux' → ["foo", "bar baz", "qux"]
 */
function parseArgs(input: string): string[] {
  const result: string[] = []
  const regex = /"([^"]*?)"|'([^']*?)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(input)) !== null) {
    result.push(match[1] ?? match[2] ?? match[3])
  }
  return result
}

/** Parse expiry string like "24h", "7d", "1w" into hours. */
function parseExpiry(s: string): number | undefined {
  const match = s.match(/^(\d+)(h|d|w)$/)
  if (!match) return undefined
  const n = Number(match[1])
  switch (match[2]) {
    case "h": return n
    case "d": return n * 24
    case "w": return n * 24 * 7
    default: return undefined
  }
}
