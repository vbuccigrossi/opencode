import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const EventJournalTable = sqliteTable(
  "event_journal",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    type: text().notNull(),
    payload: text().notNull(),
    time_created: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    index("event_journal_type_idx").on(table.type),
    index("event_journal_time_idx").on(table.time_created),
  ],
)
