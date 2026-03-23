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
import { RAG } from "../embedding/rag"
import { FileWatcher } from "../file/watcher"
import { Crawler } from "../embedding/crawler"

let unsub: (() => void) | undefined
let unsubGraph: (() => void) | undefined
let unsubFileWatcher: (() => void) | undefined
let ragReindexTimer: ReturnType<typeof setTimeout> | undefined

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

  // Auto-index RAG on startup when sources are configured (runs in background)
  setImmediate(async () => {
    try {
      const ragConfigured = await RAG.isConfigured()
      if (!ragConfigured) return

      const config = await EmbeddingProvider.getConfig()
      const available = await EmbeddingProvider.isAvailable(config)
      if (!available) {
        Log.Default.info("embedding provider not available, skipping RAG auto-index")
        return
      }

      Log.Default.info("auto-indexing RAG on startup")
      const result = await RAG.index(undefined, config)
      Log.Default.info("RAG auto-index complete", {
        totalFiles: result.totalFiles,
        changedFiles: result.changedFiles,
        chunksEmbedded: result.chunksEmbedded,
        durationMs: result.durationMs,
      })
    } catch (err: any) {
      Log.Default.warn("RAG auto-index failed", { error: err.message })
    }
  })

  // Re-index RAG when files change in source directories (debounced)
  unsubFileWatcher?.()
  unsubFileWatcher = Bus.subscribe(FileWatcher.Event.Updated, async (payload) => {
    const { file, event } = payload.properties
    if (event === "unlink" || event === "change" || event === "add") {
      // Check if this file is in a RAG source directory
      try {
        const ragConfig = await RAG.getConfig()
        if (ragConfig.sources.length === 0) return

        const resolvedSources = ragConfig.sources.map((s) => Crawler.resolvePath(s))
        const inSource = resolvedSources.some((src) => file.startsWith(src))
        if (!inSource) return

        // Debounce: wait 30s after last change before re-indexing
        if (ragReindexTimer) clearTimeout(ragReindexTimer)
        ragReindexTimer = setTimeout(async () => {
          try {
            const config = await EmbeddingProvider.getConfig()
            const available = await EmbeddingProvider.isAvailable(config)
            if (!available) return

            Log.Default.info("RAG re-indexing triggered by file changes")
            const result = await RAG.index(undefined, config)
            Log.Default.info("RAG re-index complete", {
              changedFiles: result.changedFiles,
              chunksEmbedded: result.chunksEmbedded,
              durationMs: result.durationMs,
            })
          } catch (err: any) {
            Log.Default.warn("RAG re-index failed", { error: err.message })
          }
        }, 30_000)
      } catch {
        // Config not available yet — skip
      }
    }
  })

  unsub?.()
  unsub = Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
