import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { ScheduledTaskID } from "./index"
export const ScheduledTaskTable = sqliteTable(
  "scheduled_task",
  {
    id: text().$type<ScheduledTaskID>().primaryKey(),
    project_id: text().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    cron: text().notNull(),
    prompt: text().notNull(),
    directory: text().notNull(),
    agent: text(),
    model: text(),
    delivery: text({ mode: "json" }).$type<{ type: string; [key: string]: unknown }>(),
    enabled: integer().notNull().default(1),
    last_run_at: integer(),
    last_status: text().$type<"success" | "error">(),
    last_error: text(),
    last_session_id: text(),
    next_run_at: integer(),
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$onUpdate(() => Date.now()),
  },
  (table) => [
    index("scheduled_task_project_idx").on(table.project_id),
    index("scheduled_task_next_run_idx").on(table.enabled, table.next_run_at),
  ],
)
