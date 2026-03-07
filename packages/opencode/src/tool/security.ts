import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Secrets } from "../security/secrets"
import { DepAudit } from "../security/deps"
import { SecurityPatterns } from "../security/patterns"
import { Artifact } from "../artifact"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

/**
 * Security tool — unified interface for security scanning.
 *
 * Orchestrates secret scanning, dependency auditing, and code pattern
 * analysis. Can generate consolidated security audit reports.
 */
export const SecurityTool = Tool.define("security", async () => ({
  description: `Run security scans on the project: detect hardcoded secrets, audit dependencies for vulnerabilities, and find insecure code patterns.

Operations:
- scan_secrets: Scan project files for hardcoded secrets (API keys, tokens, passwords, private keys)
- audit_deps: Audit dependencies for known vulnerabilities (npm, pip, go, cargo)
- scan_patterns: Detect insecure code patterns (SQL injection, XSS, command injection, weak crypto, etc.)
- full_audit: Run all security checks and generate a consolidated report
- check_file: Run all applicable checks on a specific file (useful after edits)

Categories for scan_patterns: injection, auth, crypto, path_traversal, info_disclosure, misconfiguration, xss

Results are sorted by severity (critical first). Use full_audit for comprehensive security reviews.`,
  parameters: z.object({
    operation: z
      .enum(["scan_secrets", "audit_deps", "scan_patterns", "full_audit", "check_file"])
      .describe("The security operation to perform"),
    file: z.string().optional().describe("File path (for check_file operation)"),
    categories: z
      .array(z.string())
      .optional()
      .describe("Pattern categories to scan (for scan_patterns: injection, auth, crypto, path_traversal, info_disclosure, misconfiguration, xss)"),
    report_title: z.string().optional().describe("Custom title for the audit report (for full_audit)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "scan_secrets":
        return scanSecrets(ctx)
      case "audit_deps":
        return auditDeps()
      case "scan_patterns":
        return scanPatterns(params, ctx)
      case "full_audit":
        return fullAudit(params, ctx)
      case "check_file":
        return checkFile(params)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.security" })

async function scanSecrets(ctx: Tool.Context): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const findings = await Secrets.scan(Instance.directory)
  const output = Secrets.format(findings, Instance.directory)

  return {
    title: `security: ${findings.length} secret(s) found`,
    metadata: {
      count: findings.length,
      critical: findings.filter((f) => f.severity === "critical").length,
      high: findings.filter((f) => f.severity === "high").length,
    },
    output,
  }
}

async function auditDeps(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const results = await DepAudit.scan(Instance.directory)
  const totalVulns = results.reduce((sum, r) => sum + r.vulnerabilities.length, 0)
  const output = DepAudit.format(results)

  return {
    title: `security: ${totalVulns} dependency vulnerability(ies)`,
    metadata: {
      vulnerabilities: totalVulns,
      packageManagers: results.map((r) => r.packageManager),
    },
    output,
  }
}

async function scanPatterns(
  params: { categories?: string[] },
  ctx: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const findings = await SecurityPatterns.scan(Instance.directory, {
    categories: params.categories as SecurityPatterns.Category[] | undefined,
  })
  const output = SecurityPatterns.format(findings, Instance.directory)

  return {
    title: `security: ${findings.length} pattern issue(s)`,
    metadata: {
      count: findings.length,
      categories: [...new Set(findings.map((f) => f.category))],
    },
    output,
  }
}

async function fullAudit(
  params: { report_title?: string },
  ctx: Tool.Context,
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const title = params.report_title ?? "Security Audit"

  // Run all scans in parallel
  const [secretFindings, depResults, patternFindings] = await Promise.all([
    Secrets.scan(Instance.directory),
    DepAudit.scan(Instance.directory),
    SecurityPatterns.scan(Instance.directory),
  ])

  const totalVulns = depResults.reduce((sum, r) => sum + r.vulnerabilities.length, 0)

  // Build report content
  const sections: string[] = [
    `# ${title}`,
    "",
    "## Executive Summary",
    "",
    `- **Secrets:** ${secretFindings.length} finding(s)`,
    `- **Dependency Vulnerabilities:** ${totalVulns} finding(s)`,
    `- **Code Pattern Issues:** ${patternFindings.length} finding(s)`,
    `- **Total:** ${secretFindings.length + totalVulns + patternFindings.length} finding(s)`,
    "",
  ]

  // Severity summary
  const allSeverities = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of secretFindings) allSeverities[f.severity]++
  for (const r of depResults)
    for (const v of r.vulnerabilities) {
      if (v.severity in allSeverities) allSeverities[v.severity as keyof typeof allSeverities]++
    }
  for (const f of patternFindings) {
    if (f.severity in allSeverities) allSeverities[f.severity as keyof typeof allSeverities]++
  }

  sections.push(
    `**Severity Breakdown:** Critical: ${allSeverities.critical}, High: ${allSeverities.high}, Medium: ${allSeverities.medium}, Low: ${allSeverities.low}`,
    "",
  )

  // Secrets section
  sections.push("## Secrets Scan", "")
  sections.push(Secrets.format(secretFindings, Instance.directory))
  sections.push("")

  // Dependencies section
  sections.push("## Dependency Audit", "")
  sections.push(DepAudit.format(depResults))
  sections.push("")

  // Patterns section
  sections.push("## Code Pattern Analysis", "")
  sections.push(SecurityPatterns.format(patternFindings, Instance.directory))
  sections.push("")

  // Remediation priority
  const criticals = [
    ...secretFindings.filter((f) => f.severity === "critical").map((f) => `Secret: ${f.pattern} in ${path.relative(Instance.directory, f.file)}:${f.line}`),
    ...depResults.flatMap((r) =>
      r.vulnerabilities.filter((v) => v.severity === "critical").map((v) => `Dep: ${v.package}@${v.version} — ${v.vulnerability}`),
    ),
    ...patternFindings.filter((f) => f.severity === "critical").map((f) => `Code: ${f.title} in ${path.relative(Instance.directory, f.file)}:${f.line}`),
  ]

  if (criticals.length > 0) {
    sections.push("## Remediation Priority (Critical)", "")
    for (let i = 0; i < criticals.length; i++) {
      sections.push(`${i + 1}. ${criticals[i]}`)
    }
    sections.push("")
  }

  const content = sections.join("\n")

  // Create artifact
  const artifact = Artifact.create({
    sessionID: ctx.sessionID,
    type: "report",
    title,
    content,
  })

  log.info("full audit", {
    secrets: secretFindings.length,
    deps: totalVulns,
    patterns: patternFindings.length,
    reportID: artifact.id,
  })

  return {
    title: `security: full audit (${secretFindings.length + totalVulns + patternFindings.length} findings)`,
    metadata: {
      reportID: artifact.id,
      secrets: secretFindings.length,
      dependencies: totalVulns,
      patterns: patternFindings.length,
      total: secretFindings.length + totalVulns + patternFindings.length,
    },
    output: content,
  }
}

async function checkFile(params: { file?: string }): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.file) throw new Error("file parameter is required for check_file operation")

  const filePath = path.resolve(Instance.directory, params.file)
  let content: string
  try {
    const fs = await import("fs/promises")
    content = await fs.readFile(filePath, "utf-8")
  } catch {
    throw new Error(`Cannot read file: ${params.file}`)
  }

  const secretFindings = Secrets.scanFile(content, filePath)
  const patternFindings = SecurityPatterns.scanFile(content, filePath)
  const total = secretFindings.length + patternFindings.length

  const lines: string[] = []
  if (total === 0) {
    lines.push(`No security issues found in ${params.file}.`)
  } else {
    lines.push(`Found ${total} issue(s) in ${params.file}:`)
    lines.push("")
    if (secretFindings.length > 0) {
      lines.push("### Secrets")
      lines.push(Secrets.format(secretFindings, Instance.directory))
    }
    if (patternFindings.length > 0) {
      lines.push("### Code Patterns")
      lines.push(SecurityPatterns.format(patternFindings, Instance.directory))
    }
  }

  return {
    title: `security: check ${path.basename(filePath)} (${total} issues)`,
    metadata: { file: filePath, secrets: secretFindings.length, patterns: patternFindings.length },
    output: lines.join("\n"),
  }
}
