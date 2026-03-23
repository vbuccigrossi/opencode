import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import type { ApiTokenID } from "./token"

export const ApiTokenTable = sqliteTable(
  "api_token",
  {
    id: text().$type<ApiTokenID>().primaryKey(),
    name: text().notNull(),
    token_hash: text().notNull().unique(),
    token_prefix: text().notNull(),
    scopes: text().notNull().default('["*"]'),
    expires_at: integer(),
    last_used_at: integer(),
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$onUpdate(() => Date.now()),
  },
  (table) => [
    index("api_token_hash_idx").on(table.token_hash),
  ],
)
