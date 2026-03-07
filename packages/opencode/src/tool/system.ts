import z from "zod"
import { Tool } from "./tool"
import { System } from "../system"
import { Log } from "../util/log"

/**
 * System environment tool — inspect OS info, runtimes, resources, ports, and environment variables.
 *
 * Provides structured access to system state without ad-hoc bash command parsing.
 */
export const SystemTool = Tool.define("system", async () => ({
  description: `Inspect the system environment with structured results.

Operations:
- info: Get OS, architecture, hostname, kernel, shell, and uptime.
- runtimes: Detect installed runtimes and their versions (node, bun, python, go, rust, java, ruby, etc.).
- resources: Get memory, CPU, and disk usage summary.
- ports: List listening TCP ports with associated processes.
- env: Read environment variables (secrets are automatically masked). Optional prefix filter.
- packages: Search installed packages (npm global, pip). Optional query filter.
- install: Install a package via a detected package manager (npm, pip, brew, apt, cargo).

Use this instead of running ad-hoc shell commands to query system state.`,
  parameters: z.object({
    operation: z
      .enum(["info", "runtimes", "resources", "ports", "env", "packages", "install"])
      .describe("The system operation to perform"),
    filter: z.string().optional().describe("Filter prefix for env, or search query for packages"),
    package_name: z.string().optional().describe("Package name (for install operation)"),
    manager: z.string().optional().describe("Package manager override (npm, pip, brew, apt, cargo, bun)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "info":
        return systemInfo()
      case "runtimes":
        return systemRuntimes()
      case "resources":
        return systemResources()
      case "ports":
        return systemPorts()
      case "env":
        return systemEnv(params.filter)
      case "packages":
        return systemPackages(params.filter, params.manager)
      case "install":
        return systemInstall(params.package_name, params.manager)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.system" })

function systemInfo(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const si = System.info()
  return Promise.resolve({
    title: `system: ${si.os} (${si.arch})`,
    metadata: { os: si.os, arch: si.arch, hostname: si.hostname },
    output: System.formatInfo(),
  })
}

function systemRuntimes(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const rts = System.runtimes()
  return Promise.resolve({
    title: `system: ${rts.length} runtime(s) detected`,
    metadata: { count: rts.length, names: rts.map((r) => r.name) },
    output: System.formatRuntimes(),
  })
}

function systemResources(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const res = System.resources()
  return Promise.resolve({
    title: `system: ${res.memory.usedPercent}% memory, ${res.cpu.cores} cores`,
    metadata: { memoryPercent: res.memory.usedPercent, cores: res.cpu.cores },
    output: System.formatResources(),
  })
}

function systemPorts(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const pts = System.ports()
  const output = pts.length === 0
    ? "No listening ports detected."
    : pts.map((p) => `${p.address}:${p.port} (${p.protocol})${p.process ? ` — ${p.process} [${p.pid}]` : ""}`).join("\n")

  return Promise.resolve({
    title: `system: ${pts.length} listening port(s)`,
    metadata: { count: pts.length },
    output,
  })
}

function systemEnv(filter?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const vars = System.env(filter)
  const output = vars.length === 0
    ? `No environment variables${filter ? ` matching "${filter}"` : ""}.`
    : vars.map((v) => `${v.name}=${v.value}`).join("\n")

  return Promise.resolve({
    title: `system: ${vars.length} env var(s)${filter ? ` (${filter}*)` : ""}`,
    metadata: { count: vars.length, filter },
    output,
  })
}

function systemPackages(query?: string, manager?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const pkgs = System.packages(query, manager)
  const output = pkgs.length === 0
    ? `No packages found${query ? ` matching "${query}"` : ""}.`
    : pkgs.map((p) => `${p.name}@${p.version} (${p.manager})`).join("\n")

  return Promise.resolve({
    title: `system: ${pkgs.length} package(s)`,
    metadata: { count: pkgs.length, query },
    output,
  })
}

function systemInstall(packageName?: string, manager?: string): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!packageName) throw new Error("package_name is required for install operation")

  const result = System.install(packageName, manager)
  return Promise.resolve({
    title: `system: installed ${packageName}`,
    metadata: { package: packageName, manager },
    output: result,
  })
}
