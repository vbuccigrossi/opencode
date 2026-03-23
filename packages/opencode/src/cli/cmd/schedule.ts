import { cmd } from "./cmd"
import { Schedule } from "../../schedule"
import { Instance } from "../../project/instance"

/** Wrap a handler in Instance.provide so it has access to the project DB. */
async function withInstance(fn: () => Promise<void>): Promise<void> {
  await Instance.provide({
    directory: process.cwd(),
    fn,
  })
}

export const ScheduleCommand = cmd({
  command: "schedule",
  describe: "manage scheduled tasks",
  builder: (yargs) =>
    yargs
      .command(
        "list",
        "list all scheduled tasks",
        {},
        async () => {
          await withInstance(async () => {
            const tasks = Schedule.list(Instance.project.id)
            if (tasks.length === 0) {
              console.log("No scheduled tasks.")
              return
            }

            for (const task of tasks) {
              const status = task.enabled ? "enabled" : "disabled"
              const next = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "none"
              const last = task.lastRunAt ? `${task.lastStatus} at ${new Date(task.lastRunAt).toLocaleString()}` : "never"
              console.log(`${task.id}  ${task.name}`)
              console.log(`  cron: ${task.cron}  status: ${status}`)
              console.log(`  next: ${next}  last: ${last}`)
              console.log(`  delivery: ${task.delivery.type}`)
              console.log()
            }
          })
        },
      )
      .command(
        "add",
        "create a scheduled task",
        {
          name: { type: "string" as const, demandOption: true, describe: "Task name" },
          cron: { type: "string" as const, demandOption: true, describe: "Cron expression" },
          prompt: { type: "string" as const, demandOption: true, describe: "LLM prompt to execute" },
          agent: { type: "string" as const, describe: "Agent override" },
          model: { type: "string" as const, describe: "Model override (e.g. ollama/devstral-16k:latest)" },
          "delivery-type": { type: "string" as const, describe: "Delivery type: session, file, webhook" },
          "delivery-path": { type: "string" as const, describe: "File path for file delivery" },
          "delivery-url": { type: "string" as const, describe: "URL for webhook delivery" },
        },
        async (args) => {
          await withInstance(async () => {
            let delivery: Schedule.DeliveryConfig | undefined
            if (args["delivery-type"] === "file" && args["delivery-path"]) {
              delivery = { type: "file", path: args["delivery-path"] }
            } else if (args["delivery-type"] === "webhook" && args["delivery-url"]) {
              delivery = { type: "webhook", url: args["delivery-url"] }
            }

            const task = Schedule.create({
              name: args.name,
              cron: args.cron,
              prompt: args.prompt,
              agent: args.agent,
              model: args.model,
              delivery,
            })

            console.log(`Created: ${task.id}`)
            console.log(`  name: ${task.name}`)
            console.log(`  cron: ${task.cron}`)
            console.log(`  next: ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "unknown"}`)
          })
        },
      )
      .command(
        "remove <id>",
        "remove a scheduled task",
        { id: { type: "string" as const, demandOption: true } },
        async (args) => {
          await withInstance(async () => {
            Schedule.remove(args.id)
            console.log(`Removed: ${args.id}`)
          })
        },
      )
      .command(
        "enable <id>",
        "enable a scheduled task",
        { id: { type: "string" as const, demandOption: true } },
        async (args) => {
          await withInstance(async () => {
            const task = Schedule.update({ id: args.id, enabled: true })
            console.log(`Enabled: ${task.name} (next: ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "unknown"})`)
          })
        },
      )
      .command(
        "disable <id>",
        "disable a scheduled task",
        { id: { type: "string" as const, demandOption: true } },
        async (args) => {
          await withInstance(async () => {
            Schedule.update({ id: args.id, enabled: false })
            console.log(`Disabled: ${args.id}`)
          })
        },
      )
      .demandCommand(1, "Specify a subcommand: list, add, remove, enable, disable"),
  handler: async () => {},
})
