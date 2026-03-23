import { randomBytes } from "crypto"
import { eq } from "drizzle-orm"
import { Database } from "../storage/db"
import { ApiTokenTable } from "./token.sql"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import z from "zod"

const log = Log.create({ service: "auth.token" })

/** Branded ID type for API tokens. */
export type ApiTokenID = string & { readonly __brand: "ApiTokenID" }

export namespace ApiToken {
  // ── Schemas ──

  export const Info = z.object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    lastUsedAt: z.number().optional(),
    expiresAt: z.number().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    name: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    expiresAt: z.number().optional(),
  })
  export type CreateInput = z.infer<typeof CreateInput>

  // ── Events ──

  export const Event = {
    Created: BusEvent.define("api_token.created", z.object({ info: Info })),
    Revoked: BusEvent.define("api_token.revoked", z.object({ id: z.string() })),
  }

  // ── Token generation ──

  /**
   * Generate a cryptographically secure API token.
   * Format: ctx_<48 random hex chars>
   * The prefix "ctx_" makes tokens easily identifiable in logs/configs.
   */
  function generateToken(): string {
    return `ctx_${randomBytes(24).toString("hex")}`
  }

  /**
   * Hash a token for storage. We store only the hash —
   * the plaintext token is returned once on creation and never stored.
   */
  async function hashToken(token: string): Promise<string> {
    const encoder = new TextEncoder()
    const data = encoder.encode(token)
    const hash = await crypto.subtle.digest("SHA-256", data)
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }

  // ── CRUD ──

  /** Ensure the api_token table exists (idempotent). */
  function ensureTable(): void {
    Database.use((db) => {
      db.run(/*sql*/ `CREATE TABLE IF NOT EXISTS api_token (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '["*"]',
        expires_at INTEGER,
        last_used_at INTEGER,
        time_created INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        time_updated INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )`)
      db.run(/*sql*/ `CREATE INDEX IF NOT EXISTS api_token_hash_idx ON api_token (token_hash)`)
    })
  }

  let tableReady = false
  function ensureReady(): void {
    if (tableReady) return
    ensureTable()
    tableReady = true
  }

  /**
   * Create a new API token. Returns the full token string ONCE —
   * it is not stored and cannot be retrieved later.
   */
  export async function create(input: CreateInput): Promise<{ token: string; info: Info }> {
    ensureReady()
    const token = generateToken()
    const hash = await hashToken(token)
    const prefix = token.slice(0, 8) // "ctx_XXXX" — for display/identification
    const now = Date.now()
    const id = `tok_${randomBytes(8).toString("hex")}` as ApiTokenID
    const scopes = input.scopes ?? ["*"]

    const row = {
      id,
      name: input.name,
      token_hash: hash,
      token_prefix: prefix,
      scopes: JSON.stringify(scopes),
      expires_at: input.expiresAt ?? null,
      last_used_at: null,
      time_created: now,
      time_updated: now,
    }

    Database.use((db) => {
      db.insert(ApiTokenTable).values(row).run()
    })

    const info: Info = {
      id,
      name: input.name,
      prefix,
      scopes,
      expiresAt: input.expiresAt,
      time: { created: now, updated: now },
    }

    log.info("created API token", { id, name: input.name, prefix })
    Bus.publish(Event.Created, { info })

    return { token, info }
  }

  /**
   * Validate a bearer token. Returns the token info if valid, undefined if not.
   * Updates last_used_at on successful validation.
   */
  export async function validate(token: string): Promise<Info | undefined> {
    if (!token.startsWith("ctx_")) return undefined
    ensureReady()

    const hash = await hashToken(token)
    const row = Database.use((db) =>
      db.select().from(ApiTokenTable).where(eq(ApiTokenTable.token_hash, hash)).get(),
    )

    if (!row) return undefined

    // Check expiration
    if (row.expires_at && row.expires_at < Date.now()) {
      log.info("token expired", { id: row.id })
      return undefined
    }

    // Update last_used_at
    const now = Date.now()
    Database.use((db) => {
      db.update(ApiTokenTable)
        .set({ last_used_at: now, time_updated: now })
        .where(eq(ApiTokenTable.id, row.id))
        .run()
    })

    return {
      id: row.id,
      name: row.name,
      prefix: row.token_prefix,
      scopes: JSON.parse(row.scopes),
      lastUsedAt: now,
      expiresAt: row.expires_at ?? undefined,
      time: { created: row.time_created, updated: now },
    }
  }

  /** Check if a token has a specific scope. "*" grants all scopes. */
  export function hasScope(info: Info, scope: string): boolean {
    return info.scopes.includes("*") || info.scopes.includes(scope)
  }

  /** List all tokens (without hashes). */
  export function list(): Info[] {
    ensureReady()
    return Database.use((db) =>
      db
        .select()
        .from(ApiTokenTable)
        .all()
        .map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.token_prefix,
          scopes: JSON.parse(row.scopes),
          lastUsedAt: row.last_used_at ?? undefined,
          expiresAt: row.expires_at ?? undefined,
          time: { created: row.time_created, updated: row.time_updated },
        })),
    )
  }

  /** Revoke (delete) a token by ID. */
  export function revoke(id: string): void {
    Database.use((db) => {
      db.delete(ApiTokenTable).where(eq(ApiTokenTable.id, id as ApiTokenID)).run()
    })
    log.info("revoked API token", { id })
    Bus.publish(Event.Revoked, { id })
  }
}
