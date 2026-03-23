import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import z from "zod"
import { Schedule } from "../schedule"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { MessageV2 } from "../session/message-v2"
import { Database } from "../storage/db"
import { MessageTable } from "../session/session.sql"
import { eq } from "drizzle-orm"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { ProviderID, ModelID } from "../provider/schema"

const log = Log.create({ service: "mcp-server" })

/**
 * Creates the Cortex MCP server with tools for scheduling and session management.
 * Returns a Hono app that handles MCP protocol at its root path.
 */
export function createMcpServer(): Hono {
  const server = new McpServer({
    name: "cortex",
    version: "1.0.0",
  })

  // ── Schedule Tools ──

  server.tool(
    "schedule_list",
    "List all scheduled tasks",
    {},
    async () => {
      const tasks = Schedule.list(Instance.project.id)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(tasks, null, 2),
          },
        ],
      }
    },
  )

  server.tool(
    "schedule_create",
    "Create a new scheduled task. Cron expressions use standard format (e.g. '0 1 * * *' for daily at 1AM, '0 9 * * 6' for Saturdays at 9AM).",
    {
      name: z.string().describe("Human-readable task name"),
      cron: z.string().describe("Cron expression for the schedule"),
      prompt: z.string().describe("The prompt to send to the LLM when the task fires"),
      directory: z.string().optional().describe("Working directory for the task (defaults to current)"),
      agent: z.string().optional().describe("Agent name override"),
      model: z.string().optional().describe("Model override (e.g. 'ollama/devstral-16k:latest')"),
      delivery_type: z
        .enum(["session", "file", "webhook"])
        .optional()
        .describe("How to deliver results (default: session)"),
      delivery_path: z.string().optional().describe("File path for 'file' delivery"),
      delivery_url: z.string().optional().describe("URL for 'webhook' delivery"),
    },
    async (args) => {
      const cronErr = Schedule.validateCron(args.cron)
      if (cronErr) {
        return { content: [{ type: "text" as const, text: `Error: Invalid cron expression — ${cronErr}` }] }
      }

      let delivery: Schedule.DeliveryConfig = { type: "session" }
      if (args.delivery_type === "file" && args.delivery_path) {
        delivery = { type: "file", path: args.delivery_path }
      } else if (args.delivery_type === "webhook" && args.delivery_url) {
        delivery = { type: "webhook", url: args.delivery_url }
      }

      const task = Schedule.create({
        name: args.name,
        cron: args.cron,
        prompt: args.prompt,
        directory: args.directory,
        agent: args.agent,
        model: args.model,
        delivery,
      })

      return {
        content: [
          {
            type: "text" as const,
            text: `Created scheduled task "${task.name}" (${task.id})\nCron: ${task.cron}\nNext run: ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "unknown"}`,
          },
        ],
      }
    },
  )

  server.tool(
    "schedule_update",
    "Update an existing scheduled task",
    {
      id: z.string().describe("Task ID to update"),
      name: z.string().optional().describe("New task name"),
      cron: z.string().optional().describe("New cron expression"),
      prompt: z.string().optional().describe("New prompt"),
      enabled: z.boolean().optional().describe("Enable or disable the task"),
    },
    async (args) => {
      try {
        const task = Schedule.update(args)
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated task "${task.name}" (${task.id})\nEnabled: ${task.enabled}\nNext run: ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "none"}`,
            },
          ],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] }
      }
    },
  )

  server.tool(
    "schedule_delete",
    "Delete a scheduled task",
    {
      id: z.string().describe("Task ID to delete"),
    },
    async (args) => {
      Schedule.remove(args.id)
      return { content: [{ type: "text" as const, text: `Deleted task ${args.id}` }] }
    },
  )

  server.tool(
    "schedule_trigger",
    "Trigger immediate execution of a scheduled task (runs it now regardless of cron schedule)",
    {
      id: z.string().describe("Task ID to trigger"),
    },
    async (args) => {
      const { Scheduler } = await import("../schedule/scheduler")
      const result = await Scheduler.triggerNow(args.id)

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] }
      }

      return {
        content: [
          { type: "text" as const, text: `Task triggered and completed successfully.` },
        ],
      }
    },
  )

  // ── Session Tools ──

  server.tool(
    "session_list",
    "List recent sessions",
    {
      limit: z.number().optional().describe("Max number of sessions to return (default: 20)"),
    },
    async (args) => {
      const sessions = [...Session.list()]
      const limited = sessions.slice(0, args.limit ?? 20)
      const summary = limited.map((s) => ({
        id: s.id,
        title: s.title,
        directory: s.directory,
        created: new Date(s.time.created).toLocaleString(),
        updated: new Date(s.time.updated).toLocaleString(),
      }))
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] }
    },
  )

  server.tool(
    "session_create",
    "Create a new session and optionally send an initial prompt",
    {
      title: z.string().optional().describe("Session title"),
      prompt: z.string().optional().describe("Initial prompt to send"),
      agent: z.string().optional().describe("Agent name"),
      model: z.string().optional().describe("Model (e.g. 'ollama/devstral-16k:latest')"),
    },
    async (args) => {
      const session = await Session.create({ title: args.title })

      if (args.prompt) {
        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: args.prompt }],
          agent: args.agent,
          model: args.model
            ? { providerID: ProviderID.make(args.model.split("/")[0]), modelID: ModelID.make(args.model.split("/").slice(1).join("/")) }
            : undefined,
        })
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Session created: ${session.id}\nTitle: ${session.title}${args.prompt ? "\nPrompt sent and executed." : ""}`,
          },
        ],
      }
    },
  )

  server.tool(
    "session_prompt",
    "Send a prompt to an existing session",
    {
      session_id: z.string().describe("Session ID"),
      prompt: z.string().describe("The prompt text to send"),
    },
    async (args) => {
      try {
        await SessionPrompt.prompt({
          sessionID: args.session_id as any,
          parts: [{ type: "text", text: args.prompt }],
        })

        // Extract the response
        const text = extractLastAssistant(args.session_id)
        return { content: [{ type: "text" as const, text }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] }
      }
    },
  )

  server.tool(
    "session_messages",
    "Get messages from a session",
    {
      session_id: z.string().describe("Session ID"),
      limit: z.number().optional().describe("Max messages to return (default: 10)"),
    },
    async (args) => {
      const rows = Database.use((db) =>
        db.select().from(MessageTable).where(eq(MessageTable.session_id, args.session_id as any)).all(),
      )

      const messages = rows.slice(-(args.limit ?? 10)).map((row) => {
        const data = row.data as any
        const parts = (data?.parts ?? []) as MessageV2.Part[]
        const textParts = parts.filter((p): p is MessageV2.TextPart => p.type === "text")
        return {
          id: row.id,
          role: data?.role ?? "unknown",
          text: textParts.map((p) => p.text).join("\n"),
          created: new Date(row.time_created).toLocaleString(),
        }
      })

      return { content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }] }
    },
  )

  // ── Token Management Tools ──

  server.tool(
    "token_list",
    "List all API tokens (shows name, prefix, scopes — never the full token)",
    {},
    async () => {
      const { ApiToken } = await import("../auth/token")
      const tokens = ApiToken.list()
      return { content: [{ type: "text" as const, text: JSON.stringify(tokens, null, 2) }] }
    },
  )

  server.tool(
    "token_create",
    "Create a new API token for cross-device access. Returns the full token ONCE — save it securely.",
    {
      name: z.string().describe("Human-readable token name (e.g. 'phone-app', 'laptop')"),
      scopes: z
        .array(z.string())
        .optional()
        .describe('Permission scopes (default: ["*"] = full access). Options: "read", "write", "schedule", "*"'),
      expires_in_days: z.number().optional().describe("Token expiry in days (default: no expiry)"),
    },
    async (args) => {
      const { ApiToken } = await import("../auth/token")
      const expiresAt = args.expires_in_days ? Date.now() + args.expires_in_days * 86400000 : undefined

      const { token, info } = await ApiToken.create({
        name: args.name,
        scopes: args.scopes ?? ["*"],
        expiresAt,
      })

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `API Token created: ${info.name}`,
              `Token: ${token}`,
              `ID: ${info.id}`,
              `Scopes: ${info.scopes.join(", ")}`,
              info.expiresAt ? `Expires: ${new Date(info.expiresAt).toLocaleString()}` : "Expires: never",
              "",
              "IMPORTANT: Save this token now — it cannot be retrieved again.",
              "Use it as: Authorization: Bearer " + token,
            ].join("\n"),
          },
        ],
      }
    },
  )

  server.tool(
    "token_revoke",
    "Revoke (delete) an API token",
    {
      id: z.string().describe("Token ID to revoke"),
    },
    async (args) => {
      const { ApiToken } = await import("../auth/token")
      ApiToken.revoke(args.id)
      return { content: [{ type: "text" as const, text: `Token ${args.id} revoked.` }] }
    },
  )

  // ── Device Management Tools ──

  server.tool(
    "device_register",
    "Register a new device for multi-device sync and push notifications",
    {
      name: z.string().describe("Device name (e.g. 'iPhone', 'work-laptop')"),
      type: z.string().optional().describe("Device type: phone, laptop, tablet, desktop, cli"),
      push_url: z.string().optional().describe("Webhook URL for push notifications"),
      push_events: z
        .array(z.string())
        .optional()
        .describe('Event types to push (default: ["*"]). Options: "session.*", "schedule.*", "message.*"'),
    },
    async (args) => {
      const { Device } = await import("../device")
      const info = Device.register({
        name: args.name,
        type: args.type,
        pushUrl: args.push_url,
        pushEvents: args.push_events,
      })

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Device registered: ${info.name}`,
              `ID: ${info.id}`,
              `Type: ${info.type}`,
              info.pushUrl ? `Push URL: ${info.pushUrl}` : "Push: disabled (no URL)",
              `Events: ${info.pushEvents.join(", ")}`,
            ].join("\n"),
          },
        ],
      }
    },
  )

  server.tool(
    "device_list",
    "List all registered devices",
    {},
    async () => {
      const { Device } = await import("../device")
      const devices = Device.list()
      return { content: [{ type: "text" as const, text: JSON.stringify(devices, null, 2) }] }
    },
  )

  server.tool(
    "device_remove",
    "Remove a registered device",
    {
      id: z.string().describe("Device ID to remove"),
    },
    async (args) => {
      const { Device } = await import("../device")
      Device.remove(args.id)
      return { content: [{ type: "text" as const, text: `Device ${args.id} removed.` }] }
    },
  )

  server.tool(
    "device_sync",
    "Sync a device — returns events since last sync and optionally a session list",
    {
      device_id: z.string().describe("Device ID to sync"),
      include_sessions: z.boolean().optional().describe("Include full session list (default: false)"),
      limit: z.number().optional().describe("Max events to return (default: 200)"),
    },
    async (args) => {
      const { DeviceSync } = await import("../device/sync")
      try {
        const result = DeviceSync.sync({
          deviceID: args.device_id,
          includeSessions: args.include_sessions,
          limit: args.limit,
        })
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] }
      }
    },
  )

  // ── Helper ──

  function extractLastAssistant(sessionID: string): string {
    const rows = Database.use((db) =>
      db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID as any)).all(),
    )

    for (let i = rows.length - 1; i >= 0; i--) {
      const data = rows[i].data as any
      if (data?.role === "assistant") {
        const parts = (data.parts ?? []) as MessageV2.Part[]
        const textParts = parts.filter((p): p is MessageV2.TextPart => p.type === "text")
        if (textParts.length > 0) return textParts.map((p) => p.text).join("\n")
      }
    }
    return "(no response)"
  }

  // ── HTTP Transport ──

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  server.connect(transport)

  const app = new Hono()

  // Expose MCP-specific headers (auth + base CORS handled by parent server)
  app.use(async (c, next) => {
    await next()
    c.header("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version")
  })

  // MCP protocol endpoint — handles both POST (requests) and GET (SSE streaming)
  app.all("/*", async (c) => {
    try {
      const response = await transport.handleRequest(c.req.raw)
      return response
    } catch (err) {
      log.error("mcp-server error", { error: err })
      return c.json({ error: "Internal MCP server error" }, 500)
    }
  })

  log.info("MCP server initialized with tools", {
    tools: ["schedule_*", "session_*", "token_*", "device_*"],
  })

  return app
}
