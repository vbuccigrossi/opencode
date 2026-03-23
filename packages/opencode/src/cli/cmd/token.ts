import { cmd } from "./cmd"
import { Instance } from "../../project/instance"

/** Wrap a handler in Instance.provide so it has access to the project DB. */
async function withInstance(fn: () => Promise<void>): Promise<void> {
  await Instance.provide({
    directory: process.cwd(),
    fn,
  })
}

export const TokenCommand = cmd({
  command: "token",
  describe: "manage API tokens for cross-device access",
  builder: (yargs) =>
    yargs
      .command(
        "create",
        "create a new API token",
        {
          name: { type: "string" as const, demandOption: true, describe: "Token name (e.g. 'phone-app')" },
          scopes: { type: "string" as const, describe: 'Comma-separated scopes (default: "*")' },
          "expires-days": { type: "number" as const, describe: "Expiry in days (default: no expiry)" },
        },
        async (args) => {
          await withInstance(async () => {
            const { ApiToken } = await import("../../auth/token")
            const scopes = args.scopes ? args.scopes.split(",").map((s) => s.trim()) : ["*"]
            const expiresAt = args["expires-days"] ? Date.now() + args["expires-days"] * 86400000 : undefined

            const { token, info } = await ApiToken.create({
              name: args.name,
              scopes,
              expiresAt,
            })

            console.log(`\nAPI Token created successfully!\n`)
            console.log(`  Name:    ${info.name}`)
            console.log(`  ID:      ${info.id}`)
            console.log(`  Scopes:  ${info.scopes.join(", ")}`)
            if (info.expiresAt) {
              console.log(`  Expires: ${new Date(info.expiresAt).toLocaleString()}`)
            }
            console.log(`\n  Token: ${token}\n`)
            console.log(`  Save this token now — it cannot be retrieved again.`)
            console.log(`  Usage: curl -H "Authorization: Bearer ${token}" http://host:port/...`)
            console.log()
          })
        },
      )
      .command(
        "list",
        "list all API tokens",
        {},
        async () => {
          await withInstance(async () => {
            const { ApiToken } = await import("../../auth/token")
            const tokens = ApiToken.list()

            if (tokens.length === 0) {
              console.log("No API tokens.")
              return
            }

            for (const t of tokens) {
              const lastUsed = t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"
              const expires = t.expiresAt ? new Date(t.expiresAt).toLocaleString() : "never"
              console.log(`${t.id}  ${t.name}  (${t.prefix}...)`)
              console.log(`  scopes: ${t.scopes.join(", ")}`)
              console.log(`  last used: ${lastUsed}  expires: ${expires}`)
              console.log()
            }
          })
        },
      )
      .command(
        "revoke <id>",
        "revoke (delete) an API token",
        { id: { type: "string" as const, demandOption: true } },
        async (args) => {
          await withInstance(async () => {
            const { ApiToken } = await import("../../auth/token")
            ApiToken.revoke(args.id)
            console.log(`Revoked: ${args.id}`)
          })
        },
      )
      .demandCommand(1, "Specify a subcommand: create, list, revoke"),
  handler: async () => {},
})
