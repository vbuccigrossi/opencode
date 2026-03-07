import z from "zod"
import { Tool } from "./tool"
import { Container } from "../container"
import { Log } from "../util/log"

/**
 * Container operations tool — manage Docker containers and Docker Compose services.
 *
 * Provides structured access to container state, logs, and lifecycle operations.
 */
export const ContainerTool = Tool.define("container", async () => ({
  description: `Manage Docker containers and Docker Compose services with structured results.

Operations:
- ps: List running containers (set all=true to include stopped).
- images: List local Docker images.
- logs: Get container logs (supports tail and since filters).
- inspect: Get detailed container info (env, mounts, ports, network, health).
- exec: Execute a command inside a running container.
- build: Build a Docker image from a Dockerfile.
- control: Start, stop, or restart a container.
- compose_up: Start Docker Compose services.
- compose_down: Stop Docker Compose services.
- compose_status: Show status of Docker Compose services.

Requires Docker to be installed and accessible. Use ps first to see available containers.`,
  parameters: z.object({
    operation: z
      .enum(["ps", "images", "logs", "inspect", "exec", "build", "control", "compose_up", "compose_down", "compose_status"])
      .describe("The container operation to perform"),
    container: z.string().optional().describe("Container name or ID (for logs, inspect, exec, control)"),
    command: z.string().optional().describe("Command to execute (for exec)"),
    all: z.boolean().optional().describe("Include stopped containers (for ps, default: false)"),
    tail: z.number().optional().describe("Number of log lines from the end (for logs)"),
    since: z.string().optional().describe("Show logs since timestamp or duration, e.g. '10m' (for logs)"),
    tag: z.string().optional().describe("Image tag (for build)"),
    context: z.string().optional().describe("Build context path (for build, default: '.')"),
    dockerfile: z.string().optional().describe("Dockerfile path (for build)"),
    action: z.enum(["start", "stop", "restart"]).optional().describe("Control action (for control)"),
    cwd: z.string().optional().describe("Directory containing docker-compose.yml (for compose_*)"),
    services: z.array(z.string()).optional().describe("Specific services to start (for compose_up)"),
    remove_volumes: z.boolean().optional().describe("Remove volumes on compose_down (default: false)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    // Check Docker availability for all operations
    if (!Container.isAvailable()) {
      return {
        title: "container: docker not available",
        metadata: { error: true },
        output: "Docker is not installed or not accessible. Ensure docker is in your PATH and the daemon is running.",
      }
    }

    switch (params.operation) {
      case "ps":
        return containerPs(params.all)
      case "images":
        return containerImages()
      case "logs":
        return containerLogs(params.container, params.tail, params.since)
      case "inspect":
        return containerInspect(params.container)
      case "exec":
        return containerExec(params.container, params.command)
      case "build":
        return containerBuild(params.tag, params.context, params.dockerfile)
      case "control":
        return containerControl(params.container, params.action)
      case "compose_up":
        return composeUp(params.cwd, params.services)
      case "compose_down":
        return composeDown(params.cwd, params.remove_volumes)
      case "compose_status":
        return composeStatus(params.cwd)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.container" })

function containerPs(all?: boolean): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const containers = Container.ps(all ?? false)
  return Promise.resolve({
    title: `container: ${containers.length} container(s)`,
    metadata: { count: containers.length, all: all ?? false },
    output: Container.formatPs(containers),
  })
}

function containerImages(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const imgs = Container.images()
  const output = imgs.length === 0
    ? "No local Docker images."
    : imgs.map((i) => `${i.repository}:${i.tag} (${i.size}) — ${i.id}`).join("\n")

  return Promise.resolve({
    title: `container: ${imgs.length} image(s)`,
    metadata: { count: imgs.length },
    output,
  })
}

function containerLogs(container?: string, tail?: number, since?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!container) throw new Error("container parameter is required for logs")

  const output = Container.logs(container, { tail, since })
  return Promise.resolve({
    title: `container: logs ${container}`,
    metadata: { container, tail, since },
    output: output.trim() || "(no log output)",
  })
}

function containerInspect(container?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!container) throw new Error("container parameter is required for inspect")

  const info = Container.inspect(container)
  const lines: string[] = [
    `Name: ${info.name}`,
    `Image: ${info.image}`,
    `State: ${info.state}`,
    `Network: ${info.networkMode}`,
    `Restart: ${info.restartPolicy}`,
  ]

  if (info.health) lines.push(`Health: ${info.health}`)

  if (Object.keys(info.ports).length > 0) {
    lines.push("Ports:")
    for (const [containerPort, hostBind] of Object.entries(info.ports)) {
      lines.push(`  ${containerPort} -> ${hostBind}`)
    }
  }

  if (info.mounts.length > 0) {
    lines.push("Mounts:")
    for (const m of info.mounts) {
      lines.push(`  ${m.source} -> ${m.destination} (${m.mode})`)
    }
  }

  if (info.env.length > 0) {
    lines.push(`Environment: ${info.env.length} variables`)
    for (const e of info.env.slice(0, 20)) {
      lines.push(`  ${e}`)
    }
    if (info.env.length > 20) lines.push(`  ... and ${info.env.length - 20} more`)
  }

  return Promise.resolve({
    title: `container: inspect ${info.name}`,
    metadata: { name: info.name, state: info.state, image: info.image },
    output: lines.join("\n"),
  })
}

function containerExec(container?: string, command?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!container) throw new Error("container parameter is required for exec")
  if (!command) throw new Error("command parameter is required for exec")

  const output = Container.exec(container, command)
  return Promise.resolve({
    title: `container: exec ${container}`,
    metadata: { container, command },
    output: output.trim() || "(no output)",
  })
}

function containerBuild(tag?: string, context?: string, dockerfile?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!tag) throw new Error("tag parameter is required for build")

  const output = Container.build(tag, context ?? ".", dockerfile)
  return Promise.resolve({
    title: `container: build ${tag}`,
    metadata: { tag, context: context ?? ".", dockerfile },
    output,
  })
}

function containerControl(container?: string, action?: "start" | "stop" | "restart"): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!container) throw new Error("container parameter is required for control")
  if (!action) throw new Error("action parameter is required for control")

  const output = Container.control(container, action)
  return Promise.resolve({
    title: `container: ${action} ${container}`,
    metadata: { container, action },
    output: output.trim() || `Container ${container} ${action}ed successfully.`,
  })
}

function composeUp(cwd?: string, services?: string[]): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!cwd) throw new Error("cwd parameter is required for compose_up")

  const output = Container.composeUp(cwd, services)
  return Promise.resolve({
    title: `container: compose up${services ? ` (${services.join(", ")})` : ""}`,
    metadata: { cwd, services },
    output: output.trim() || "Docker Compose services started.",
  })
}

function composeDown(cwd?: string, removeVolumes?: boolean): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!cwd) throw new Error("cwd parameter is required for compose_down")

  const output = Container.composeDown(cwd, removeVolumes ?? false)
  return Promise.resolve({
    title: `container: compose down`,
    metadata: { cwd, removeVolumes: removeVolumes ?? false },
    output: output.trim() || "Docker Compose services stopped.",
  })
}

function composeStatus(cwd?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!cwd) throw new Error("cwd parameter is required for compose_status")

  const services = Container.composeStatus(cwd)
  const output = services.length === 0
    ? "No Docker Compose services found."
    : services.map((s) => `${s.name}: ${s.status}${s.ports ? ` [${s.ports}]` : ""}`).join("\n")

  return Promise.resolve({
    title: `container: ${services.length} compose service(s)`,
    metadata: { count: services.length, cwd },
    output,
  })
}
