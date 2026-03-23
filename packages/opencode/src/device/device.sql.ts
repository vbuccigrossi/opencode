import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import type { DeviceID } from "./index"

export const DeviceTable = sqliteTable(
  "device",
  {
    id: text().$type<DeviceID>().primaryKey(),
    name: text().notNull(),
    type: text().notNull().default("unknown"), // "phone", "laptop", "tablet", "desktop", "cli", "unknown"
    push_url: text(), // Webhook URL for push notifications
    push_headers: text(), // JSON: additional headers for push requests
    push_events: text().notNull().default('["*"]'), // JSON: event type filters
    last_seen_seq: integer().notNull().default(0), // Event journal sequence cursor
    last_sync_at: integer(), // Last time this device synced
    capabilities: text().notNull().default("[]"), // JSON: ["sessions", "schedules", "notifications"]
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$onUpdate(() => Date.now()),
  },
  (table) => [index("device_name_idx").on(table.name)],
)
