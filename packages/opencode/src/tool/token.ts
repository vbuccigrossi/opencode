import z from "zod"
import { Tool } from "./tool"
import { ApiToken } from "../auth/token"
import { Log } from "../util/log"

/**
 * Token tool — manage API tokens for authenticating external clients.
 *
 * API tokens use bearer authentication and are scoped with permissions.
 * Tokens are displayed once on creation and cannot be retrieved afterwards.
 */
export const TokenTool = Tool.define("token", async () => ({
  description: `Manage API tokens for authenticating external clients to the Cortex server.

Operations:
- list: List all API tokens (shows prefix and scopes, never the full token).
- create: Create a new API token. The full token is shown ONCE — save it immediately.
- revoke: Revoke (delete) an API token by ID.

Tokens authenticate via the Authorization header: "Bearer ctx_..."
Scopes control access (default: ["*"] = full access). Custom scopes can restrict
tokens to specific operations like "schedule:read", "session:write", etc.

Tokens can have an optional expiration timestamp (milliseconds since epoch).`,
  parameters: z.object({
    operation: z
      .enum(["list", "create", "revoke"])
      .describe("The token operation to perform"),
    id: z.string().optional().describe("Token ID (for revoke)"),
    name: z.string().optional().describe("Token name/label (for create)"),
    scopes: z.array(z.string()).optional().describe('Permission scopes (default: ["*"]). For create'),
    expires_in_hours: z.number().optional().describe("Expire token after this many hours (for create)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "list":
        return tokenList()
      case "create":
        return tokenCreate(params)
      case "revoke":
        return tokenRevoke(params)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.token" })

function formatTokenInfo(t: ApiToken.Info): string {
  const lastUsed = t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"
  const expires = t.expiresAt ? new Date(t.expiresAt).toLocaleString() : "never"
  return [
    `ID: ${t.id}`,
    `Name: ${t.name}`,
    `Prefix: ${t.prefix}...`,
    `Scopes: ${t.scopes.join(", ")}`,
    `Last used: ${lastUsed}`,
    `Expires: ${expires}`,
    `Created: ${new Date(t.time.created).toLocaleString()}`,
  ].join("\n")
}

function tokenList(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const tokens = ApiToken.list()
  if (tokens.length === 0) {
    return Promise.resolve({
      title: "token: none",
      metadata: { count: 0 },
      output: "No API tokens.",
    })
  }

  const output = tokens.map(formatTokenInfo).join("\n\n---\n\n")
  return Promise.resolve({
    title: `token: ${tokens.length} token(s)`,
    metadata: { count: tokens.length },
    output,
  })
}

async function tokenCreate(params: {
  name?: string
  scopes?: string[]
  expires_in_hours?: number
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.name) throw new Error("name is required for create")

  const expiresAt = params.expires_in_hours
    ? Date.now() + params.expires_in_hours * 60 * 60 * 1000
    : undefined

  const { token, info } = await ApiToken.create({
    name: params.name,
    scopes: params.scopes,
    expiresAt,
  })

  const output = [
    "Token created successfully.",
    "",
    "⚠ SAVE THIS TOKEN NOW — it cannot be retrieved later:",
    "",
    `  ${token}`,
    "",
    "Usage:",
    `  curl -H "Authorization: Bearer ${token}" http://localhost:3000/...`,
    "",
    formatTokenInfo(info),
  ].join("\n")

  return {
    title: `token: created "${info.name}"`,
    metadata: { id: info.id, prefix: info.prefix },
    output,
  }
}

function tokenRevoke(params: { id?: string }): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for revoke")

  // Verify it exists first
  const tokens = ApiToken.list()
  const existing = tokens.find((t) => t.id === params.id)
  if (!existing) throw new Error(`Token ${params.id} not found`)

  ApiToken.revoke(params.id)
  return Promise.resolve({
    title: `token: revoked "${existing.name}"`,
    metadata: { id: params.id },
    output: `Revoked token "${existing.name}" (${params.id}).`,
  })
}
