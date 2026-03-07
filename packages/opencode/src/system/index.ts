import { Log } from "@/util/log"
import { execSync } from "child_process"
import { platform, arch, hostname, release, uptime, totalmem, freemem, cpus } from "os"

/**
 * System environment inspection — provides structured access to
 * OS info, installed runtimes, packages, resources, ports, and
 * environment variables.
 */
export namespace System {
  const log = Log.create({ service: "system" })

  /** System information summary. */
  export interface SystemInfo {
    os: string
    arch: string
    hostname: string
    kernel: string
    shell: string
    uptime: number
    uptimeHuman: string
  }

  /** Detected runtime with version. */
  export interface RuntimeInfo {
    name: string
    version: string
    path: string
  }

  /** Resource usage summary. */
  export interface ResourceInfo {
    memory: {
      total: number
      free: number
      used: number
      usedPercent: number
    }
    cpu: {
      model: string
      cores: number
      loadAvg: number[]
    }
    disk: Array<{
      filesystem: string
      size: string
      used: string
      available: string
      usedPercent: string
      mountpoint: string
    }>
  }

  /** Listening port info. */
  export interface PortInfo {
    port: number
    protocol: string
    process?: string
    pid?: number
    address: string
  }

  /** Installed package info. */
  export interface PackageInfo {
    name: string
    version: string
    manager: string
  }

  /**
   * Get system information.
   *
   * @returns OS, architecture, hostname, kernel, shell, uptime
   */
  export function info(): SystemInfo {
    const uptimeSecs = uptime()
    const hours = Math.floor(uptimeSecs / 3600)
    const mins = Math.floor((uptimeSecs % 3600) / 60)

    return {
      os: `${platform()} ${release()}`,
      arch: arch(),
      hostname: hostname(),
      kernel: release(),
      shell: process.env.SHELL ?? "unknown",
      uptime: uptimeSecs,
      uptimeHuman: `${hours}h ${mins}m`,
    }
  }

  /**
   * Detect installed runtimes and their versions.
   *
   * @returns Array of detected runtimes
   */
  export function runtimes(): RuntimeInfo[] {
    const results: RuntimeInfo[] = []
    const checks: Array<{ name: string; cmd: string; versionFlag: string }> = [
      { name: "node", cmd: "node", versionFlag: "--version" },
      { name: "bun", cmd: "bun", versionFlag: "--version" },
      { name: "deno", cmd: "deno", versionFlag: "--version" },
      { name: "python3", cmd: "python3", versionFlag: "--version" },
      { name: "python", cmd: "python", versionFlag: "--version" },
      { name: "go", cmd: "go", versionFlag: "version" },
      { name: "rustc", cmd: "rustc", versionFlag: "--version" },
      { name: "cargo", cmd: "cargo", versionFlag: "--version" },
      { name: "java", cmd: "java", versionFlag: "-version" },
      { name: "ruby", cmd: "ruby", versionFlag: "--version" },
      { name: "dotnet", cmd: "dotnet", versionFlag: "--version" },
      { name: "gcc", cmd: "gcc", versionFlag: "--version" },
      { name: "git", cmd: "git", versionFlag: "--version" },
      { name: "docker", cmd: "docker", versionFlag: "--version" },
    ]

    for (const check of checks) {
      try {
        const version = run(`${check.cmd} ${check.versionFlag} 2>&1`).trim().split("\n")[0] ?? ""
        const path = run(`which ${check.cmd} 2>/dev/null`).trim()
        if (version) {
          results.push({
            name: check.name,
            version: extractVersion(version),
            path,
          })
        }
      } catch {}
    }

    return results
  }

  /**
   * Get resource usage (memory, CPU, disk).
   *
   * @returns Resource usage summary
   */
  export function resources(): ResourceInfo {
    const totalMem = totalmem()
    const freeMem = freemem()
    const usedMem = totalMem - freeMem
    const cpuInfo = cpus()
    const loadAvg = (() => {
      try {
        const { loadavg } = require("os")
        return loadavg()
      } catch {
        return [0, 0, 0]
      }
    })()

    // Parse disk usage
    const disk: ResourceInfo["disk"] = []
    try {
      const dfOutput = run("df -h --output=source,size,used,avail,pcent,target 2>/dev/null || df -h 2>/dev/null")
      const lines = dfOutput.trim().split("\n").slice(1)
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 6 && !parts[0].startsWith("tmpfs") && !parts[0].startsWith("devtmpfs")) {
          disk.push({
            filesystem: parts[0],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            usedPercent: parts[4],
            mountpoint: parts[5],
          })
        }
      }
    } catch {}

    return {
      memory: {
        total: Math.round(totalMem / 1024 / 1024),
        free: Math.round(freeMem / 1024 / 1024),
        used: Math.round(usedMem / 1024 / 1024),
        usedPercent: Math.round((usedMem / totalMem) * 100),
      },
      cpu: {
        model: cpuInfo[0]?.model ?? "unknown",
        cores: cpuInfo.length,
        loadAvg,
      },
      disk,
    }
  }

  /**
   * List listening ports.
   *
   * @returns Array of port information
   */
  export function ports(): PortInfo[] {
    const results: PortInfo[] = []

    try {
      // Try ss first (modern Linux), fall back to lsof
      let output: string
      try {
        output = run("ss -tlnp 2>/dev/null")
      } catch {
        output = run("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null")
      }

      const lines = output.trim().split("\n").slice(1)
      for (const line of lines) {
        const parsed = parsePortLine(line)
        if (parsed) results.push(parsed)
      }
    } catch {}

    return results
  }

  /**
   * Read environment variables.
   *
   * Masks values that look like secrets (keys, tokens, passwords).
   *
   * @param filter - Optional name filter (prefix match)
   * @returns Array of [name, value] pairs
   */
  export function env(filter?: string): Array<{ name: string; value: string }> {
    const results: Array<{ name: string; value: string }> = []
    const SECRET_PATTERNS = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|API_KEY|PRIVATE)/i

    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (filter && !name.toLowerCase().startsWith(filter.toLowerCase())) continue

      const masked = SECRET_PATTERNS.test(name) ? maskValue(value) : value
      results.push({ name, value: masked })
    }

    // Sort alphabetically
    results.sort((a, b) => a.name.localeCompare(b.name))
    return results
  }

  /**
   * Install a package using the appropriate package manager.
   *
   * @param packageName - Package to install
   * @param manager - Package manager to use (auto-detected if not specified)
   * @returns Installation output
   */
  export function install(packageName: string, manager?: string): string {
    const mgr = manager ?? detectPackageManager()
    if (!mgr) throw new Error("No package manager detected")

    const cmds: Record<string, string> = {
      apt: `sudo apt-get install -y ${packageName}`,
      brew: `brew install ${packageName}`,
      pip: `pip install ${packageName}`,
      npm: `npm install -g ${packageName}`,
      bun: `bun add -g ${packageName}`,
      cargo: `cargo install ${packageName}`,
    }

    const cmd = cmds[mgr]
    if (!cmd) throw new Error(`Unsupported package manager: ${mgr}`)

    return run(cmd)
  }

  /**
   * Search for installed packages.
   *
   * @param query - Search query
   * @param manager - Package manager (optional)
   * @returns Array of matching packages
   */
  export function packages(query?: string, manager?: string): PackageInfo[] {
    const results: PackageInfo[] = []

    // npm global
    if (!manager || manager === "npm") {
      try {
        const output = run("npm list -g --depth=0 --json 2>/dev/null")
        const data = JSON.parse(output)
        for (const [name, info] of Object.entries<any>(data.dependencies ?? {})) {
          if (!query || name.includes(query)) {
            results.push({ name, version: info.version ?? "unknown", manager: "npm" })
          }
        }
      } catch {}
    }

    // pip
    if (!manager || manager === "pip") {
      try {
        const output = run("pip list --format=json 2>/dev/null")
        const pkgs = JSON.parse(output)
        for (const pkg of pkgs) {
          if (!query || pkg.name.toLowerCase().includes(query.toLowerCase())) {
            results.push({ name: pkg.name, version: pkg.version, manager: "pip" })
          }
        }
      } catch {}
    }

    return results
  }

  /**
   * Format system info as a human-readable summary.
   *
   * @returns Formatted string
   */
  export function formatInfo(): string {
    const si = info()
    const lines: string[] = []
    lines.push(`OS: ${si.os} (${si.arch})`)
    lines.push(`Hostname: ${si.hostname}`)
    lines.push(`Shell: ${si.shell}`)
    lines.push(`Uptime: ${si.uptimeHuman}`)
    return lines.join("\n")
  }

  /**
   * Format runtimes as a human-readable list.
   *
   * @returns Formatted string
   */
  export function formatRuntimes(): string {
    const rts = runtimes()
    if (rts.length === 0) return "No runtimes detected."
    return rts.map((r) => `${r.name}: ${r.version} (${r.path})`).join("\n")
  }

  /**
   * Format resources as a human-readable summary.
   *
   * @returns Formatted string
   */
  export function formatResources(): string {
    const res = resources()
    const lines: string[] = []
    lines.push(`Memory: ${res.memory.used}MB / ${res.memory.total}MB (${res.memory.usedPercent}% used)`)
    lines.push(`CPU: ${res.cpu.cores} cores (${res.cpu.model})`)
    lines.push(`Load: ${res.cpu.loadAvg.map((l) => l.toFixed(2)).join(", ")}`)
    if (res.disk.length > 0) {
      lines.push("Disk:")
      for (const d of res.disk.slice(0, 5)) {
        lines.push(`  ${d.mountpoint}: ${d.used} / ${d.size} (${d.usedPercent})`)
      }
    }
    return lines.join("\n")
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Run a shell command and return stdout. */
  function run(cmd: string): string {
    return execSync(cmd, { encoding: "utf-8", timeout: 10_000 })
  }

  /** Extract a version string from command output. */
  function extractVersion(output: string): string {
    const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[-+]\S*)?)/)
    return match ? match[1] : output.trim().slice(0, 50)
  }

  /** Detect available package manager. */
  function detectPackageManager(): string | undefined {
    const managers = ["bun", "npm", "pip", "brew", "apt", "cargo"]
    for (const mgr of managers) {
      try {
        run(`which ${mgr} 2>/dev/null`)
        return mgr
      } catch {}
    }
    return undefined
  }

  /** Mask a secret value, showing only first 3 chars. */
  function maskValue(value: string): string {
    if (value.length <= 4) return "****"
    return value.slice(0, 3) + "****"
  }

  /** Parse a single line of ss or lsof output into PortInfo. */
  function parsePortLine(line: string): PortInfo | undefined {
    // ss format: LISTEN 0 4096 *:3000 *:*
    const ssMatch = line.match(/LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s/)
    if (ssMatch) {
      const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/)
      return {
        address: ssMatch[1],
        port: parseInt(ssMatch[2], 10),
        protocol: "tcp",
        process: processMatch?.[1],
        pid: processMatch ? parseInt(processMatch[2], 10) : undefined,
      }
    }

    // lsof format: node 12345 user 21u IPv4 ... TCP *:3000 (LISTEN)
    const lsofMatch = line.match(/^(\S+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+TCP\s+(\S+):(\d+)\s/)
    if (lsofMatch) {
      return {
        address: lsofMatch[3],
        port: parseInt(lsofMatch[4], 10),
        protocol: "tcp",
        process: lsofMatch[1],
        pid: parseInt(lsofMatch[2], 10),
      }
    }

    return undefined
  }
}
