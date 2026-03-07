import { Log } from "../util/log"
import fs from "fs/promises"
import path from "path"
import { spawn } from "child_process"

export namespace DepAudit {
  const log = Log.create({ service: "security.deps" })

  export type Severity = "critical" | "high" | "medium" | "low" | "unknown"

  /** A dependency vulnerability finding. */
  export interface Vulnerability {
    package: string
    version: string
    vulnerability: string
    severity: Severity
    description: string
    fixedVersion?: string
    advisoryUrl?: string
  }

  /** Supported package managers. */
  export type PackageManager = "npm" | "bun" | "pip" | "go" | "cargo"

  /** Audit result. */
  export interface AuditResult {
    packageManager: PackageManager
    vulnerabilities: Vulnerability[]
    totalDeps: number
    scannedAt: number
    error?: string
  }

  /** Detection result. */
  export interface DetectResult {
    packageManager: PackageManager
    lockfile: string
    manifest: string
  }

  /**
   * Detect the package manager used in a directory.
   *
   * Checks for known lockfiles and maps them to their package manager.
   * If bun is detected, npm results are excluded since bun handles
   * package.json projects natively.
   *
   * @param directory - Absolute path to the project directory.
   * @returns Array of detected package managers with their lockfile and manifest paths.
   */
  export async function detect(directory: string): Promise<DetectResult[]> {
    const results: DetectResult[] = []
    const checks: [PackageManager, string, string][] = [
      ["bun", "bun.lockb", "package.json"],
      ["bun", "bun.lock", "package.json"],
      ["npm", "package-lock.json", "package.json"],
      ["pip", "Pipfile.lock", "Pipfile"],
      ["pip", "requirements.txt", "requirements.txt"],
      ["go", "go.sum", "go.mod"],
      ["cargo", "Cargo.lock", "Cargo.toml"],
    ]

    for (const [pm, lockfile, manifest] of checks) {
      try {
        await fs.access(path.join(directory, lockfile))
        // Don't add bun twice if both bun.lockb and bun.lock exist
        if (!results.some((r) => r.packageManager === pm)) {
          results.push({ packageManager: pm, lockfile, manifest })
        }
      } catch {
        // File doesn't exist
      }
    }
    // If we found bun, skip npm (bun handles package.json projects)
    if (results.some((r) => r.packageManager === "bun")) {
      return results.filter((r) => r.packageManager !== "npm")
    }

    return results
  }

  /**
   * Run a command and capture stdout/stderr.
   *
   * @param cmd - The command to execute.
   * @param args - Arguments to pass to the command.
   * @param cwd - Working directory for the command.
   * @param timeoutMs - Maximum execution time in milliseconds (default 60000).
   * @returns Object containing stdout, stderr, and exit code.
   */
  function runCommand(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs = 60000,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => {
        proc.kill("SIGTERM")
        resolve({
          stdout,
          stderr: stderr + "\nTimeout after " + timeoutMs + "ms",
          exitCode: -1,
        })
      }, timeoutMs)

      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString()
      })
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString()
      })
      proc.on("close", (code) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      })
      proc.on("error", (err) => {
        clearTimeout(timer)
        resolve({ stdout, stderr: err.message, exitCode: -1 })
      })
    })
  }

  /**
   * Scan a directory for dependency vulnerabilities.
   *
   * Detects all package managers in the directory and runs their
   * respective audit commands, returning unified results.
   *
   * @param directory - Absolute path to the project directory.
   * @returns Array of audit results, one per detected package manager.
   */
  export async function scan(directory: string): Promise<AuditResult[]> {
    const detected = await detect(directory)
    if (detected.length === 0) {
      return [
        {
          packageManager: "npm",
          vulnerabilities: [],
          totalDeps: 0,
          scannedAt: Date.now(),
          error: "No package manager detected",
        },
      ]
    }

    const results: AuditResult[] = []
    for (const d of detected) {
      try {
        const result = await auditFor(d.packageManager, directory)
        results.push(result)
      } catch (err: any) {
        results.push({
          packageManager: d.packageManager,
          vulnerabilities: [],
          totalDeps: 0,
          scannedAt: Date.now(),
          error: err.message,
        })
      }
    }
    return results
  }

  /**
   * Dispatch to the appropriate audit function for a given package manager.
   *
   * @param pm - The package manager to audit.
   * @param directory - Absolute path to the project directory.
   * @returns Audit result for the given package manager.
   */
  async function auditFor(
    pm: PackageManager,
    directory: string,
  ): Promise<AuditResult> {
    switch (pm) {
      case "npm":
        return auditNpm(directory)
      case "bun":
        return auditBun(directory)
      case "pip":
        return auditPip(directory)
      case "go":
        return auditGo(directory)
      case "cargo":
        return auditCargo(directory)
    }
  }

  /**
   * Run npm audit and parse the JSON output.
   *
   * Supports both npm audit v1 (advisories) and v2 (vulnerabilities) formats.
   *
   * @param directory - Absolute path to the project directory.
   * @returns Audit result with parsed vulnerabilities.
   */
  async function auditNpm(directory: string): Promise<AuditResult> {
    const { stdout, stderr, exitCode } = await runCommand(
      "npm",
      ["audit", "--json"],
      directory,
    )
    const vulns: Vulnerability[] = []
    let totalDeps = 0

    try {
      const data = JSON.parse(stdout)
      totalDeps = data.metadata?.totalDependencies ?? 0

      // npm audit v2 format
      if (data.vulnerabilities) {
        for (const [name, info] of Object.entries<any>(data.vulnerabilities)) {
          vulns.push({
            package: name,
            version: info.range ?? "unknown",
            vulnerability:
              info.title ?? info.name ?? "Unknown vulnerability",
            severity: mapSeverity(info.severity),
            description: info.title ?? "",
            fixedVersion: info.fixAvailable?.version,
            advisoryUrl: info.url,
          })
        }
      }
      // npm audit v1 format
      else if (data.advisories) {
        for (const [, advisory] of Object.entries<any>(data.advisories)) {
          vulns.push({
            package: advisory.module_name,
            version: advisory.vulnerable_versions ?? "unknown",
            vulnerability: advisory.title,
            severity: mapSeverity(advisory.severity),
            description: advisory.overview ?? "",
            fixedVersion: advisory.patched_versions,
            advisoryUrl: advisory.url,
          })
        }
      }
    } catch {
      if (exitCode !== 0) {
        return {
          packageManager: "npm",
          vulnerabilities: [],
          totalDeps: 0,
          scannedAt: Date.now(),
          error: stderr || "npm audit failed",
        }
      }
    }

    return {
      packageManager: "npm",
      vulnerabilities: vulns,
      totalDeps,
      scannedAt: Date.now(),
    }
  }

  /**
   * Run audit for bun projects.
   *
   * Bun does not have a native audit command, so this falls back to npm audit
   * when available. Dependency count is read from package.json.
   *
   * @param directory - Absolute path to the project directory.
   * @returns Audit result with parsed vulnerabilities.
   */
  async function auditBun(directory: string): Promise<AuditResult> {
    // Bun doesn't have a native audit command yet; fall back to npm audit
    // First try to count deps from package.json
    let totalDeps = 0
    try {
      const pkg = JSON.parse(
        await fs.readFile(path.join(directory, "package.json"), "utf-8"),
      )
      totalDeps =
        Object.keys(pkg.dependencies ?? {}).length +
        Object.keys(pkg.devDependencies ?? {}).length
    } catch {
      // package.json not readable
    }

    // Try npm audit (works with package.json/package-lock.json)
    const { stdout, stderr, exitCode } = await runCommand(
      "npm",
      ["audit", "--json"],
      directory,
    )
    const vulns: Vulnerability[] = []

    try {
      const data = JSON.parse(stdout)
      if (data.vulnerabilities) {
        for (const [name, info] of Object.entries<any>(data.vulnerabilities)) {
          vulns.push({
            package: name,
            version: info.range ?? "unknown",
            vulnerability: info.title ?? "Unknown vulnerability",
            severity: mapSeverity(info.severity),
            description: info.title ?? "",
            fixedVersion: info.fixAvailable?.version,
            advisoryUrl: info.url,
          })
        }
      }
    } catch {
      // npm audit might not be available
      if (exitCode !== 0 && !stdout) {
        return {
          packageManager: "bun",
          vulnerabilities: [],
          totalDeps,
          scannedAt: Date.now(),
          error: "No audit tool available for bun projects",
        }
      }
    }

    return {
      packageManager: "bun",
      vulnerabilities: vulns,
      totalDeps,
      scannedAt: Date.now(),
    }
  }

  /**
   * Run pip-audit and parse the JSON output.
   *
   * Falls back to counting dependencies from requirements.txt if pip-audit
   * is not installed.
   *
   * @param directory - Absolute path to the project directory.
   * @returns Audit result with parsed vulnerabilities.
   */
  async function auditPip(directory: string): Promise<AuditResult> {
    // Try pip-audit first
    const { stdout, stderr, exitCode } = await runCommand(
      "pip-audit",
      ["--format", "json", "--desc"],
      directory,
    )
    const vulns: Vulnerability[] = []
    let totalDeps = 0

    if (exitCode === 0 || stdout.startsWith("[")) {
      try {
        const data = JSON.parse(stdout)
        totalDeps = Array.isArray(data) ? data.length : 0
        for (const entry of Array.isArray(data) ? data : []) {
          if (entry.vulns && entry.vulns.length > 0) {
            for (const v of entry.vulns) {
              vulns.push({
                package: entry.name,
                version: entry.version,
                vulnerability: v.id ?? "Unknown",
                severity: mapSeverity(
                  v.fix_versions?.[0] ? "high" : "medium",
                ),
                description: v.description ?? "",
                fixedVersion: v.fix_versions?.[0],
                advisoryUrl: v.aliases?.[0]
                  ? `https://nvd.nist.gov/vuln/detail/${v.aliases[0]}`
                  : undefined,
              })
            }
          }
        }
      } catch {
        // JSON parse failure
      }
    } else {
      // Count deps from requirements.txt
      try {
        const req = await fs.readFile(
          path.join(directory, "requirements.txt"),
          "utf-8",
        )
        totalDeps = req
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("#")).length
      } catch {
        // requirements.txt not readable
      }
      return {
        packageManager: "pip",
        vulnerabilities: [],
        totalDeps,
        scannedAt: Date.now(),
        error: stderr || "pip-audit not available",
      }
    }

    return {
      packageManager: "pip",
      vulnerabilities: vulns,
      totalDeps,
      scannedAt: Date.now(),
    }
  }

  /**
   * Run govulncheck for Go projects and parse the text output.
   *
   * Falls back to `go list -m all` for dependency counting. Uses an
   * extended timeout of 120s since vulnerability scanning can be slow.
   *
   * @param directory - Absolute path to the project directory.
   * @returns Audit result with parsed vulnerabilities.
   */
  async function auditGo(directory: string): Promise<AuditResult> {
    // Use govulncheck if available, else go list
    const { stdout: vulnOut, exitCode: vulnCode } = await runCommand(
      "govulncheck",
      ["./..."],
      directory,
      120000,
    )
    const vulns: Vulnerability[] = []

    // Count modules
    let totalDeps = 0
    try {
      const { stdout: modOut } = await runCommand(
        "go",
        ["list", "-m", "all"],
        directory,
      )
      totalDeps = modOut.split("\n").filter(Boolean).length - 1 // Subtract main module
    } catch {
      // go list failed
    }

    if (vulnCode === 0 || vulnOut) {
      // Parse govulncheck text output
      const vuln_blocks = vulnOut.split(/\n(?=Vulnerability #|No vulnerabilities)/)
      for (const block of vuln_blocks) {
        const idMatch = block.match(/Vulnerability #\d+:\s+(\S+)/)
        const pkgMatch = block.match(/Found in:\s+(\S+)@(\S+)/)
        const fixMatch = block.match(/Fixed in:\s+(\S+)@(\S+)/)
        const descMatch = block.match(/Description:\s+([\s\S]*?)(?:\n\n|$)/)
        if (idMatch && pkgMatch) {
          vulns.push({
            package: pkgMatch[1],
            version: pkgMatch[2],
            vulnerability: idMatch[1],
            severity: "high",
            description: descMatch?.[1]?.trim() ?? "",
            fixedVersion: fixMatch?.[2],
            advisoryUrl: `https://pkg.go.dev/vuln/${idMatch[1]}`,
          })
        }
      }
    } else {
      return {
        packageManager: "go",
        vulnerabilities: [],
        totalDeps,
        scannedAt: Date.now(),
        error: "govulncheck not available",
      }
    }

    return {
      packageManager: "go",
      vulnerabilities: vulns,
      totalDeps,
      scannedAt: Date.now(),
    }
  }

  /**
   * Run cargo audit and parse the JSON output.
   *
   * Dependency count is derived from Cargo.lock [[package]] entries.
   * Uses an extended timeout of 120s.
   *
   * @param directory - Absolute path to the project directory.
   * @returns Audit result with parsed vulnerabilities.
   */
  async function auditCargo(directory: string): Promise<AuditResult> {
    const { stdout, stderr, exitCode } = await runCommand(
      "cargo",
      ["audit", "--json"],
      directory,
      120000,
    )
    const vulns: Vulnerability[] = []
    let totalDeps = 0

    // Count crates
    try {
      const lockContent = await fs.readFile(
        path.join(directory, "Cargo.lock"),
        "utf-8",
      )
      totalDeps = (lockContent.match(/\[\[package\]\]/g) ?? []).length
    } catch {
      // Cargo.lock not readable
    }

    if (exitCode >= 0 && stdout) {
      try {
        const data = JSON.parse(stdout)
        if (data.vulnerabilities?.list) {
          for (const v of data.vulnerabilities.list) {
            const advisory = v.advisory ?? {}
            vulns.push({
              package:
                advisory.package ?? v.package?.name ?? "unknown",
              version: v.package?.version ?? "unknown",
              vulnerability: advisory.id ?? "Unknown",
              severity: mapSeverity(advisory.cvss?.severity),
              description:
                advisory.title ?? advisory.description ?? "",
              fixedVersion: v.versions?.patched?.[0],
              advisoryUrl: advisory.url,
            })
          }
        }
      } catch {
        // JSON parse failure
      }
    } else {
      return {
        packageManager: "cargo",
        vulnerabilities: [],
        totalDeps,
        scannedAt: Date.now(),
        error: stderr || "cargo-audit not available",
      }
    }

    return {
      packageManager: "cargo",
      vulnerabilities: vulns,
      totalDeps,
      scannedAt: Date.now(),
    }
  }

  /**
   * Map a severity string from various audit tool formats to the unified Severity type.
   *
   * @param input - Raw severity string from audit output.
   * @returns Normalized severity level.
   */
  function mapSeverity(input: string | undefined): Severity {
    if (!input) return "unknown"
    const lower = input.toLowerCase()
    if (lower === "critical") return "critical"
    if (lower === "high") return "high"
    if (lower === "moderate" || lower === "medium") return "medium"
    if (lower === "low") return "low"
    return "unknown"
  }

  /**
   * Format audit results as a human-readable report.
   *
   * Groups vulnerabilities by package manager, shows severity summary,
   * and lists individual findings with fix recommendations.
   *
   * @param results - Array of audit results to format.
   * @returns Formatted multi-line report string.
   */
  export function format(results: AuditResult[]): string {
    const lines: string[] = []

    for (const r of results) {
      lines.push(`## ${r.packageManager} (${r.totalDeps} dependencies)`)
      if (r.error) {
        lines.push(`  Warning: ${r.error}`)
        lines.push("")
        continue
      }
      if (r.vulnerabilities.length === 0) {
        lines.push("  No known vulnerabilities found.")
        lines.push("")
        continue
      }

      const bySev = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
      for (const v of r.vulnerabilities) bySev[v.severity]++
      lines.push(
        `  Found ${r.vulnerabilities.length} vulnerabilities: Critical=${bySev.critical}, High=${bySev.high}, Medium=${bySev.medium}, Low=${bySev.low}`,
      )
      lines.push("")

      for (const v of r.vulnerabilities) {
        lines.push(
          `  [${v.severity.toUpperCase()}] ${v.package}@${v.version} -- ${v.vulnerability}`,
        )
        if (v.description)
          lines.push(`    ${v.description.substring(0, 200)}`)
        if (v.fixedVersion)
          lines.push(`    Fix: upgrade to ${v.fixedVersion}`)
        if (v.advisoryUrl) lines.push(`    ${v.advisoryUrl}`)
        lines.push("")
      }
    }

    return lines.join("\n")
  }
}
