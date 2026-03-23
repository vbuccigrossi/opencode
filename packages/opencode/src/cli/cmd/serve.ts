import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Scheduler } from "../../schedule/scheduler"
import { Daemon } from "../../daemon"
import { Log } from "../../util/log"

const log = Log.create({ service: "serve" })

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .command(
        "start",
        "start the cortex server as a background daemon",
        (y) => y,
        async (args) => {
          try {
            const info = await Daemon.start({
              port: args.port,
              hostname: args.hostname,
            })
            console.log(`Cortex daemon running (pid ${info.pid})`)
            console.log(`  URL: http://${info.hostname}:${info.port}`)
            console.log(`  MCP: http://${info.hostname}:${info.port}/mcp-server`)
          } catch (e) {
            console.error(`Failed to start daemon: ${e instanceof Error ? e.message : e}`)
            process.exitCode = 1
          }
        },
      )
      .command(
        "stop",
        "stop the background cortex daemon",
        (y) => y,
        async () => {
          const stopped = await Daemon.stop()
          if (stopped) {
            console.log("Cortex daemon stopped.")
          } else {
            console.log("No running daemon found.")
          }
        },
      )
      .command(
        "status",
        "check if the cortex daemon is running",
        (y) => y,
        async () => {
          const s = await Daemon.status()
          if (s.running) {
            const uptime = Math.floor((Date.now() - s.info.startedAt) / 1000)
            const hours = Math.floor(uptime / 3600)
            const mins = Math.floor((uptime % 3600) / 60)
            const secs = uptime % 60
            const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
            console.log(`Cortex daemon is running`)
            console.log(`  PID:     ${s.info.pid}`)
            console.log(`  URL:     http://${s.info.hostname}:${s.info.port}`)
            console.log(`  Uptime:  ${uptimeStr}`)
            console.log(`  Started: ${new Date(s.info.startedAt).toLocaleString()}`)
          } else {
            console.log(`Cortex daemon is not running (${s.reason})`)
          }
        },
      ),
  describe: "starts a headless cortex server with MCP and task scheduler",
  handler: async (args) => {
    // Clean up daemon state on exit — drain in-flight scheduler tasks first
    async function cleanup() {
      await Scheduler.stop()
      Daemon.clear()
    }

    for (const signal of ["SIGHUP", "SIGTERM"] as const) {
      process.once(signal, () => {
        cleanup().finally(() => process.kill(process.pid, signal))
      })
    }
    process.once("exit", () => {
      // exit handler must be sync — Scheduler.stop() was already awaited in signal handler
      Daemon.clear()
    })

    // Always warn about missing auth — including in daemon mode, where the
    // warning goes to daemon.log so operators can audit it.
    if (!Flag.CORTEX_SERVER_PASSWORD) {
      const msg = "Warning: CORTEX_SERVER_PASSWORD is not set; server is unsecured."
      if (process.env.CORTEX_DAEMON) {
        log.warn(msg)
      } else {
        console.log(msg)
      }
    }

    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)

    // Write daemon state so other processes can find us
    Daemon.write({
      pid: process.pid,
      port: server.port ?? opts.port,
      hostname: server.hostname ?? opts.hostname,
      startedAt: Date.now(),
      bin: process.execPath,
    })

    if (!process.env.CORTEX_DAEMON) {
      // Foreground mode — print info to console
      console.log(`cortex server listening on http://${server.hostname}:${server.port}`)
      console.log(`  MCP endpoint: http://${server.hostname}:${server.port}/mcp-server`)
      console.log(`  Scheduler: active (polling every 30s)`)
    }

    // Start the task scheduler (runs in its own Instance context per task)
    Scheduler.start()

    await new Promise(() => {})
    await cleanup()
    await server.stop()
  },
})
