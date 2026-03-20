import { Plugin } from "../plugin"
import { LSP } from "../lsp"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Truncate } from "../tool/truncation"
import { Graph } from "../graph"
import { Context } from "../context"
import { Changelog } from "../session/changelog"
import { Alarm } from "../alarm"
import { EmbeddingIndexer } from "../embedding/indexer"
import { EmbeddingProvider } from "../embedding/provider"

let unsub: (() => void) | undefined
let unsubGraph: (() => void) | undefined

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  ShareNext.init()
  await LSP.init()
  File.init()
  Truncate.init()
  await Graph.init()
  Context.init()
  Changelog.init()

  // Set up alarm bell notification on fire
  Alarm.onFire((alarm) => {
    const label = alarm.label
    const hasCmd = alarm.command ? ` (check: ${alarm.command})` : ""
    Log.Default.info(`\x07 Alarm fired: "${label}"${hasCmd}`)
  })

  // Auto-index embeddings after graph builds (runs in background, non-blocking)
  unsubGraph?.()
  unsubGraph = Bus.subscribe(Graph.IndexComplete, async (payload) => {
    const { projectID, total } = payload.properties
    if (total === 0) return

    // Run embedding indexing in background — don't block the agent
    setImmediate(async () => {
      try {
        const config = await EmbeddingProvider.getConfig()
        const available = await EmbeddingProvider.isAvailable(config)
        if (!available) {
          Log.Default.info("embedding provider not available, skipping auto-index")
          return
        }

        Log.Default.info("auto-indexing embeddings after graph build", { projectID, graphNodes: total })
        const result = await EmbeddingIndexer.index(projectID, Instance.worktree, config)
        Log.Default.info("embedding auto-index complete", {
          indexed: result.indexed,
          skipped: result.skipped,
          durationMs: result.durationMs,
        })
      } catch (err: any) {
        Log.Default.warn("embedding auto-index failed", { error: err.message })
      }
    })
  })

  unsub?.()
  unsub = Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
