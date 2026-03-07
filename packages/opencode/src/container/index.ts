import { Log } from "@/util/log"
import { execSync, spawn } from "child_process"

/**
 * Container operations — structured interface to Docker and
 * Docker Compose for inspecting, managing, and debugging containers.
 */
export namespace Container {
  const log = Log.create({ service: "container" })

  /** Container status info. */
  export interface ContainerInfo {
    id: string
    name: string
    image: string
    status: string
    state: "running" | "exited" | "paused" | "restarting" | "dead" | "created"
    ports: string
    created: string
    command?: string
  }

  /** Docker image info. */
  export interface ImageInfo {
    id: string
    repository: string
    tag: string
    size: string
    created: string
  }

  /** Container inspection details. */
  export interface InspectResult {
    id: string
    name: string
    image: string
    state: string
    env: string[]
    mounts: Array<{ source: string; destination: string; mode: string }>
    ports: Record<string, string>
    networkMode: string
    restartPolicy: string
    health?: string
  }

  /** Compose service status. */
  export interface ComposeService {
    name: string
    status: string
    ports: string
  }

  /**
   * Check if Docker is available.
   *
   * @returns True if docker command is accessible
   */
  export function isAvailable(): boolean {
    try {
      run("docker version --format '{{.Server.Version}}'")
      return true
    } catch {
      return false
    }
  }

  /**
   * List running containers.
   *
   * @param all - Include stopped containers (default: false)
   * @returns Array of container info
   */
  export function ps(all: boolean = false): ContainerInfo[] {
    const flag = all ? "-a" : ""
    const format = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.Ports}}\t{{.CreatedAt}}\t{{.Command}}'
    const output = run(`docker ps ${flag} --format '${format}' --no-trunc`)

    return output
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split("\t")
        return {
          id: parts[0]?.slice(0, 12) ?? "",
          name: parts[1] ?? "",
          image: parts[2] ?? "",
          status: parts[3] ?? "",
          state: (parts[4] ?? "unknown") as ContainerInfo["state"],
          ports: parts[5] ?? "",
          created: parts[6] ?? "",
          command: parts[7],
        }
      })
  }

  /**
   * List local Docker images.
   *
   * @returns Array of image info
   */
  export function images(): ImageInfo[] {
    const format = '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}'
    const output = run(`docker images --format '${format}'`)

    return output
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split("\t")
        return {
          id: parts[0]?.slice(0, 12) ?? "",
          repository: parts[1] ?? "",
          tag: parts[2] ?? "",
          size: parts[3] ?? "",
          created: parts[4] ?? "",
        }
      })
  }

  /**
   * Get container logs.
   *
   * @param container - Container name or ID
   * @param opts - Log options
   * @returns Log output
   */
  export function logs(
    container: string,
    opts?: { tail?: number; since?: string; follow?: false },
  ): string {
    const args: string[] = ["docker", "logs"]
    if (opts?.tail) args.push("--tail", String(opts.tail))
    if (opts?.since) args.push("--since", opts.since)
    args.push(container)

    return run(args.join(" "))
  }

  /**
   * Inspect a container in detail.
   *
   * @param container - Container name or ID
   * @returns Detailed container info
   */
  export function inspect(container: string): InspectResult {
    const output = run(`docker inspect ${shellEscape(container)}`)
    const data = JSON.parse(output)
    const info = data[0]

    if (!info) throw new Error(`Container not found: ${container}`)

    // Parse port bindings
    const ports: Record<string, string> = {}
    const portBindings = info.HostConfig?.PortBindings ?? {}
    for (const [containerPort, bindings] of Object.entries<any>(portBindings)) {
      if (Array.isArray(bindings) && bindings.length > 0) {
        ports[containerPort] = `${bindings[0].HostIp || "0.0.0.0"}:${bindings[0].HostPort}`
      }
    }

    // Parse mounts
    const mounts = (info.Mounts ?? []).map((m: any) => ({
      source: m.Source ?? "",
      destination: m.Destination ?? "",
      mode: m.Mode ?? "rw",
    }))

    return {
      id: info.Id?.slice(0, 12) ?? "",
      name: info.Name?.replace(/^\//, "") ?? "",
      image: info.Config?.Image ?? "",
      state: info.State?.Status ?? "unknown",
      env: info.Config?.Env ?? [],
      mounts,
      ports,
      networkMode: info.HostConfig?.NetworkMode ?? "default",
      restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? "no",
      health: info.State?.Health?.Status,
    }
  }

  /**
   * Execute a command inside a running container.
   *
   * @param container - Container name or ID
   * @param command - Command to execute
   * @returns Command output
   */
  export function exec(container: string, command: string): string {
    return run(`docker exec ${shellEscape(container)} sh -c ${shellEscape(command)}`)
  }

  /**
   * Build a Docker image.
   *
   * @param tag - Image tag
   * @param context - Build context path (default: ".")
   * @param dockerfile - Dockerfile path (optional)
   * @returns Build output
   */
  export function build(tag: string, context: string = ".", dockerfile?: string): string {
    const args = ["docker", "build", "-t", tag]
    if (dockerfile) args.push("-f", dockerfile)
    args.push(context)
    return run(args.join(" "))
  }

  /**
   * Start/stop a single container.
   *
   * @param container - Container name or ID
   * @param action - start or stop
   * @returns Command output
   */
  export function control(container: string, action: "start" | "stop" | "restart"): string {
    return run(`docker ${action} ${shellEscape(container)}`)
  }

  /**
   * Docker Compose up.
   *
   * @param cwd - Directory containing docker-compose.yml
   * @param services - Specific services to start (optional)
   * @param detach - Run in background (default: true)
   * @returns Command output
   */
  export function composeUp(cwd: string, services?: string[], detach: boolean = true): string {
    const cmd = composeCommand(cwd)
    const args = [cmd, "up"]
    if (detach) args.push("-d")
    if (services && services.length > 0) args.push(...services)
    return runInDir(args.join(" "), cwd)
  }

  /**
   * Docker Compose down.
   *
   * @param cwd - Directory containing docker-compose.yml
   * @param removeVolumes - Also remove volumes (default: false)
   * @returns Command output
   */
  export function composeDown(cwd: string, removeVolumes: boolean = false): string {
    const cmd = composeCommand(cwd)
    const args = [cmd, "down"]
    if (removeVolumes) args.push("-v")
    return runInDir(args.join(" "), cwd)
  }

  /**
   * Docker Compose status.
   *
   * @param cwd - Directory containing docker-compose.yml
   * @returns Array of service statuses
   */
  export function composeStatus(cwd: string): ComposeService[] {
    const cmd = composeCommand(cwd)
    try {
      const output = runInDir(`${cmd} ps --format json 2>/dev/null || ${cmd} ps`, cwd)

      // Try JSON format first (newer docker compose)
      try {
        const services: ComposeService[] = []
        for (const line of output.trim().split("\n")) {
          if (!line.trim()) continue
          const data = JSON.parse(line)
          services.push({
            name: data.Name ?? data.Service ?? "",
            status: data.State ?? data.Status ?? "",
            ports: data.Ports ?? data.Publishers ?? "",
          })
        }
        if (services.length > 0) return services
      } catch {}

      // Fall back to text parsing
      const lines = output.trim().split("\n").slice(1)
      return lines
        .filter((l) => l.trim())
        .map((line) => {
          const parts = line.trim().split(/\s{2,}/)
          return {
            name: parts[0] ?? "",
            status: parts[2] ?? parts[1] ?? "",
            ports: parts[3] ?? parts[parts.length - 1] ?? "",
          }
        })
    } catch {
      return []
    }
  }

  /**
   * Format container list for display.
   *
   * @param containers - Container list
   * @returns Formatted string
   */
  export function formatPs(containers: ContainerInfo[]): string {
    if (containers.length === 0) return "No containers running."

    const lines = containers.map((c) => {
      const ports = c.ports ? ` [${c.ports}]` : ""
      return `${c.name} (${c.image}) — ${c.state}${ports}`
    })

    return `${containers.length} container(s):\n${lines.join("\n")}`
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Run a command and return stdout. */
  function run(cmd: string): string {
    return execSync(cmd, { encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] })
  }

  /** Run a command in a specific directory. */
  function runInDir(cmd: string, cwd: string): string {
    return execSync(cmd, { encoding: "utf-8", timeout: 60_000, cwd, stdio: ["pipe", "pipe", "pipe"] })
  }

  /** Escape a string for shell use. */
  function shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`
  }

  /** Detect docker compose command (v2 vs v1). */
  function composeCommand(cwd: string): string {
    try {
      execSync("docker compose version", { encoding: "utf-8", timeout: 5000 })
      return "docker compose"
    } catch {
      return "docker-compose"
    }
  }
}
