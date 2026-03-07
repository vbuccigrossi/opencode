import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"

export const AgentMemoryTable = sqliteTable(
  "agent_memory",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    type: text().notNull(),
    tags: text({ mode: "json" }).$type<string[]>().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_accessed: integer().notNull(),
    access_count: integer().notNull().default(0),
  },
  (table) => [
    index("agent_memory_project_idx").on(table.project_id),
    index("agent_memory_type_idx").on(table.project_id, table.type),
    index("agent_memory_accessed_idx").on(table.project_id, table.time_accessed),
  ],
)
