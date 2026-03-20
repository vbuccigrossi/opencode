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

let unsub: (() => void) | undefined

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

  unsub?.()
  unsub = Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
