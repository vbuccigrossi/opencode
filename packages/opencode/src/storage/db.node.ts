import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"

export function init(path: string) {
  const sqlite = new DatabaseSync(path)

  // Load sqlite-vec extension for native vector similarity search
  try {
    const sqliteVec = require("sqlite-vec")
    sqliteVec.load(sqlite)
  } catch {
    // sqlite-vec not available — vector search falls back to JS cosine similarity
  }

  const db = drizzle({ client: sqlite })
  return db
}
