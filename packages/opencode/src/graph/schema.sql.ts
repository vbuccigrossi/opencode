import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"

export const GraphNodeTable = sqliteTable(
  "graph_node",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    file_path: text().notNull(),
    name: text().notNull(),
    kind: text().notNull(),
    start_line: integer().notNull(),
    end_line: integer().notNull(),
    start_col: integer().notNull(),
    end_col: integer().notNull(),
    signature: text(),
    content_hash: text().notNull(),
  },
  (table) => [
    index("graph_node_project_idx").on(table.project_id),
    index("graph_node_file_idx").on(table.project_id, table.file_path),
    index("graph_node_name_idx").on(table.project_id, table.name),
    index("graph_node_kind_idx").on(table.project_id, table.kind),
  ],
)

export const GraphEdgeTable = sqliteTable(
  "graph_edge",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    source_node_id: text()
      .notNull()
      .references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    target_node_id: text()
      .notNull()
      .references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    file_path: text().notNull(),
    line: integer(),
  },
  (table) => [
    index("graph_edge_project_idx").on(table.project_id),
    index("graph_edge_source_idx").on(table.source_node_id),
    index("graph_edge_target_idx").on(table.target_node_id),
    index("graph_edge_kind_idx").on(table.project_id, table.kind),
  ],
)

export const GraphFileStateTable = sqliteTable(
  "graph_file_state",
  {
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    file_path: text().notNull(),
    content_hash: text().notNull(),
    last_indexed: integer().notNull(),
    node_count: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.file_path] })],
)
