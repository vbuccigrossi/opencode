import { cmd } from "./cmd"
import { Instance } from "../../project/instance"

async function withInstance(fn: () => Promise<void>): Promise<void> {
  await Instance.provide({
    directory: process.cwd(),
    fn,
  })
}

export const DeviceCommand = cmd({
  command: "device",
  describe: "manage registered devices for multi-device sync",
  builder: (yargs) =>
    yargs
      .command(
        "register",
        "register a new device",
        {
          name: { type: "string" as const, demandOption: true, describe: "Device name" },
          type: { type: "string" as const, describe: "Device type (phone, laptop, tablet, desktop)" },
          "push-url": { type: "string" as const, describe: "Webhook URL for push notifications" },
        },
        async (args) => {
          await withInstance(async () => {
            const { Device } = await import("../../device")
            const info = Device.register({
              name: args.name,
              type: args.type,
              pushUrl: args["push-url"],
            })

            console.log(`\nDevice registered!\n`)
            console.log(`  ID:   ${info.id}`)
            console.log(`  Name: ${info.name}`)
            console.log(`  Type: ${info.type}`)
            if (info.pushUrl) console.log(`  Push: ${info.pushUrl}`)
            console.log()
          })
        },
      )
      .command(
        "list",
        "list all registered devices",
        {},
        async () => {
          await withInstance(async () => {
            const { Device } = await import("../../device")
            const devices = Device.list()

            if (devices.length === 0) {
              console.log("No registered devices.")
              return
            }

            for (const d of devices) {
              const lastSync = d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : "never"
              console.log(`${d.id}  ${d.name} (${d.type})`)
              console.log(`  push: ${d.pushUrl ?? "disabled"}`)
              console.log(`  last sync: ${lastSync}  seq: ${d.lastSeenSeq}`)
              console.log(`  events: ${d.pushEvents.join(", ")}`)
              console.log()
            }
          })
        },
      )
      .command(
        "remove <id>",
        "remove a registered device",
        { id: { type: "string" as const, demandOption: true } },
        async (args) => {
          await withInstance(async () => {
            const { Device } = await import("../../device")
            Device.remove(args.id)
            console.log(`Removed: ${args.id}`)
          })
        },
      )
      .command(
        "sync <id>",
        "trigger a sync for a device (shows pending events)",
        {
          id: { type: "string" as const, demandOption: true },
          sessions: { type: "boolean" as const, describe: "Include session list" },
        },
        async (args) => {
          await withInstance(async () => {
            const { DeviceSync } = await import("../../device/sync")
            try {
              const result = DeviceSync.sync({
                deviceID: args.id,
                includeSessions: args.sessions,
              })

              console.log(`Sync complete:`)
              console.log(`  Events: ${result.events.length}`)
              console.log(`  Pending: ${result.pending}`)
              console.log(`  Latest seq: ${result.latestSeq}`)
              if (result.sessions) {
                console.log(`  Sessions: ${result.sessions.length}`)
              }

              if (result.events.length > 0) {
                console.log(`\nEvents:`)
                for (const e of result.events.slice(0, 20)) {
                  console.log(`  [${e.seq}] ${e.type} (${new Date(e.timeCreated).toLocaleTimeString()})`)
                }
                if (result.events.length > 20) {
                  console.log(`  ... and ${result.events.length - 20} more`)
                }
              }
            } catch (err) {
              console.error(`Error: ${err}`)
            }
          })
        },
      )
      .demandCommand(1, "Specify a subcommand: register, list, remove, sync"),
  handler: async () => {},
})
