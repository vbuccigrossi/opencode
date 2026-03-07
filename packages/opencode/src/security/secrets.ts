import { Log } from "../util/log"
import fs from "fs/promises"
import path from "path"

/**
 * Secret scanner module for detecting hardcoded secrets in source code.
 *
 * Scans files for patterns matching known secret formats (API keys,
 * tokens, connection strings, private keys, etc.) and uses Shannon
 * entropy to reduce false positives. Supports allowlisting, category
 * filtering, and placeholder detection.
 */
export namespace Secrets {
  const log = Log.create({ service: "security.secrets" })

  /** Severity levels for findings. */
  export type Severity = "critical" | "high" | "medium" | "low"

  /** A detected secret finding. */
  export interface Finding {
    file: string
    line: number
    column: number
    pattern: string
    category: string
    severity: Severity
    snippet: string
    entropy: number
  }

  /** A secret detection pattern. */
  export interface Pattern {
    id: string
    category: string
    severity: Severity
    regex: RegExp
    description: string
    /** If true, also check entropy of matched value. */
    entropyCheck?: boolean
  }

  /** Scan options. */
  export interface ScanOptions {
    /** Specific files to scan (overrides directory scanning). */
    files?: string[]
    /** Patterns to allow (skip matches). */
    allowlist?: string[]
    /** Max files to scan. */
    maxFiles?: number
    /** Categories to scan (default: all). */
    categories?: string[]
  }

  // ---------------------------------------------------------------------------
  // Pattern registry
  // ---------------------------------------------------------------------------

  export const patterns: Pattern[] = [
    // AWS
    {
      id: "aws-access-key",
      category: "aws",
      severity: "critical",
      regex: /(?<![A-Z0-9])(AKIA[0-9A-Z]{16})(?![A-Z0-9])/g,
      description: "AWS Access Key ID",
    },
    {
      id: "aws-session-token",
      category: "aws",
      severity: "critical",
      regex: /(?<![A-Z0-9])(ASIA[0-9A-Z]{16})(?![A-Z0-9])/g,
      description: "AWS Session Token Key ID",
    },
    {
      id: "aws-secret-key",
      category: "aws",
      severity: "critical",
      regex: /aws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
      description: "AWS Secret Access Key",
      entropyCheck: true,
    },

    // GCP
    {
      id: "gcp-api-key",
      category: "gcp",
      severity: "high",
      regex: /AIza[0-9A-Za-z_-]{35}/g,
      description: "Google API Key",
    },
    {
      id: "gcp-service-account",
      category: "gcp",
      severity: "critical",
      regex: /"type"\s*:\s*"service_account"/g,
      description: "GCP Service Account JSON",
    },

    // Azure
    {
      id: "azure-connection-string",
      category: "azure",
      severity: "critical",
      regex:
        /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]+/g,
      description: "Azure Storage Connection String",
    },

    // Generic API Keys
    {
      id: "generic-api-key",
      category: "generic",
      severity: "high",
      regex:
        /(?:api[_-]?key|apikey)\s*[=:]\s*["']([a-zA-Z0-9_\-]{20,})["']/gi,
      description: "Generic API Key",
      entropyCheck: true,
    },
    {
      id: "generic-secret",
      category: "generic",
      severity: "high",
      regex:
        /(?:secret|token|password|passwd|pwd)\s*[=:]\s*["']([^"']{8,})["']/gi,
      description: "Generic Secret/Token",
      entropyCheck: true,
    },
    {
      id: "sk-key",
      category: "generic",
      severity: "critical",
      regex: /sk-[a-zA-Z0-9]{32,}/g,
      description: "Secret Key (sk- prefix)",
    },
    {
      id: "bearer-token",
      category: "generic",
      severity: "high",
      regex: /[Bb]earer\s+[a-zA-Z0-9_\-.]{20,}/g,
      description: "Bearer Token",
      entropyCheck: true,
    },

    // Private Keys
    {
      id: "private-key",
      category: "crypto",
      severity: "critical",
      regex:
        /-----BEGIN\s(?:RSA\s|EC\s|DSA\s|OPENSSH\s)?PRIVATE\sKEY-----/g,
      description: "Private Key",
    },

    // Database URLs
    {
      id: "db-url-postgres",
      category: "database",
      severity: "critical",
      regex: /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@[^\s"']+/gi,
      description: "PostgreSQL Connection URL with credentials",
    },
    {
      id: "db-url-mysql",
      category: "database",
      severity: "critical",
      regex: /mysql:\/\/[^\s"']+:[^\s"']+@[^\s"']+/gi,
      description: "MySQL Connection URL with credentials",
    },
    {
      id: "db-url-mongodb",
      category: "database",
      severity: "critical",
      regex: /mongodb(?:\+srv)?:\/\/[^\s"']+:[^\s"']+@[^\s"']+/gi,
      description: "MongoDB Connection URL with credentials",
    },
    {
      id: "db-url-redis",
      category: "database",
      severity: "high",
      regex: /redis:\/\/[^\s"']+:[^\s"']+@[^\s"']+/gi,
      description: "Redis Connection URL with credentials",
    },

    // JWT
    {
      id: "jwt-token",
      category: "auth",
      severity: "high",
      regex: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
      description: "JSON Web Token",
    },

    // GitHub
    {
      id: "github-token",
      category: "github",
      severity: "critical",
      regex: /ghp_[a-zA-Z0-9]{36}/g,
      description: "GitHub Personal Access Token",
    },
    {
      id: "github-oauth",
      category: "github",
      severity: "critical",
      regex: /gho_[a-zA-Z0-9]{36}/g,
      description: "GitHub OAuth Token",
    },
    {
      id: "github-app",
      category: "github",
      severity: "critical",
      regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/g,
      description: "GitHub App Token",
    },

    // Slack
    {
      id: "slack-token",
      category: "slack",
      severity: "high",
      regex: /xox[bpors]-[a-zA-Z0-9-]{10,}/g,
      description: "Slack Token",
    },
    {
      id: "slack-webhook",
      category: "slack",
      severity: "medium",
      regex:
        /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9]+\/B[a-zA-Z0-9]+\/[a-zA-Z0-9]+/g,
      description: "Slack Webhook URL",
    },

    // Stripe
    {
      id: "stripe-secret",
      category: "stripe",
      severity: "critical",
      regex: /sk_(?:live|test)_[a-zA-Z0-9]{24,}/g,
      description: "Stripe Secret Key",
    },
    {
      id: "stripe-publishable",
      category: "stripe",
      severity: "low",
      regex: /pk_(?:live|test)_[a-zA-Z0-9]{24,}/g,
      description: "Stripe Publishable Key",
    },
  ]

  // ---------------------------------------------------------------------------
  // Skip lists
  // ---------------------------------------------------------------------------

  /** File extensions to skip (binary/generated). */
  const SKIP_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".webp",
    ".bmp",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
    ".zip",
    ".gz",
    ".tar",
    ".bz2",
    ".7z",
    ".rar",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".o",
    ".a",
    ".wasm",
    ".bin",
    ".dat",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
    ".wav",
    ".lock",
    ".lockb",
  ])

  /** Paths to always skip. */
  const SKIP_PATHS = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    "__pycache__",
    ".tox",
    "venv",
    ".venv",
    "target",
    ".opencode",
    ".claude",
  ]

  // ---------------------------------------------------------------------------
  // Entropy
  // ---------------------------------------------------------------------------

  /**
   * Calculate Shannon entropy of a string.
   *
   * Higher entropy indicates more randomness, which correlates with
   * real secrets vs. placeholder values. A typical English word has
   * entropy around 2-3 bits; a base64-encoded key sits around 4-5.
   *
   * @param str - The string to measure.
   * @returns Entropy in bits per character.
   */
  export function shannonEntropy(str: string): number {
    if (str.length === 0) return 0
    const freq = new Map<string, number>()
    for (const char of str) {
      freq.set(char, (freq.get(char) ?? 0) + 1)
    }
    let entropy = 0
    for (const count of freq.values()) {
      const p = count / str.length
      if (p > 0) entropy -= p * Math.log2(p)
    }
    return entropy
  }

  /** Minimum entropy threshold for flagging secrets. */
  const MIN_ENTROPY = 3.0

  // ---------------------------------------------------------------------------
  // Placeholder detection
  // ---------------------------------------------------------------------------

  /** Placeholder patterns to skip. */
  const PLACEHOLDER_PATTERNS = [
    /^[x]+$/i, // xxxx
    /^[*]+$/, // ****
    /^<[^>]+>$/, // <your-key-here>
    /^\$\{/, // ${VAR}
    /^%\(/, // %(var)s
    /^your[_-]/i, // your-api-key
    /^example/i, // example_key
    /^test[_-]?/i, // test_key
    /^dummy/i, // dummy_secret
    /^placeholder/i, // placeholder
    /^change[_-]?me/i, // changeme
    /^todo/i, // todo
    /^fixme/i, // fixme
    /^replace/i, // replace_this
    /^insert/i, // insert_key_here
  ]

  /**
   * Determine whether a matched value is a placeholder rather than a real secret.
   *
   * @param value - The captured match text.
   * @returns True if the value looks like a placeholder.
   */
  function isPlaceholder(value: string): boolean {
    return PLACEHOLDER_PATTERNS.some((p) => p.test(value.trim()))
  }

  // ---------------------------------------------------------------------------
  // File filtering
  // ---------------------------------------------------------------------------

  /**
   * Determine whether a file should be skipped based on extension or path.
   *
   * @param filePath - Absolute or relative path to the file.
   * @returns True if the file should not be scanned.
   */
  function shouldSkipFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    if (SKIP_EXTENSIONS.has(ext)) return true
    const parts = filePath.split(path.sep)
    return parts.some((p) => SKIP_PATHS.includes(p))
  }

  // ---------------------------------------------------------------------------
  // Single-file scanning
  // ---------------------------------------------------------------------------

  /**
   * Scan a single file's content for secrets.
   *
   * Iterates every registered pattern (optionally filtered by category)
   * against every line. Matches are validated against the allowlist,
   * placeholder detector, and entropy threshold before being emitted.
   *
   * @param content  - The file content as a string.
   * @param filePath - Path used for reporting and skip-checks.
   * @param options  - Optional scan configuration.
   * @returns Array of findings for this file.
   */
  export function scanFile(
    content: string,
    filePath: string,
    options?: ScanOptions,
  ): Finding[] {
    if (shouldSkipFile(filePath)) return []

    const findings: Finding[] = []
    const lines = content.split("\n")
    const allowlist = options?.allowlist ?? []
    const categories = options?.categories ? new Set(options.categories) : null

    for (const pattern of patterns) {
      if (categories && !categories.has(pattern.category)) continue

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]

        // Skip comments that look like documentation
        const trimmed = line.trim()
        if (
          trimmed.startsWith("//") &&
          (trimmed.includes("example") || trimmed.includes("TODO"))
        )
          continue

        // Reset regex state for this line
        pattern.regex.lastIndex = 0
        let match: RegExpExecArray | null

        while ((match = pattern.regex.exec(line)) !== null) {
          const matchedValue = match[1] ?? match[0]

          // Check allowlist
          if (
            allowlist.some(
              (a) => matchedValue.includes(a) || line.includes(a),
            )
          )
            continue

          // Check placeholder
          if (isPlaceholder(matchedValue)) continue

          // Entropy check
          const entropy = shannonEntropy(matchedValue)
          if (pattern.entropyCheck && entropy < MIN_ENTROPY) continue

          // Skip test files for low-severity findings
          const isTest =
            /\.(test|spec)\.[jt]sx?$|__tests__|test_|_test\./i.test(filePath)
          if (isTest && pattern.severity === "low") continue

          const snippet = line.trim().substring(0, 120)

          findings.push({
            file: filePath,
            line: lineIdx + 1,
            column: match.index + 1,
            pattern: pattern.id,
            category: pattern.category,
            severity: pattern.severity,
            snippet,
            entropy: Math.round(entropy * 100) / 100,
          })
        }
      }
    }

    return findings
  }

  // ---------------------------------------------------------------------------
  // Directory scanning
  // ---------------------------------------------------------------------------

  /**
   * Scan a directory (or explicit file list) for hardcoded secrets.
   *
   * When `options.files` is provided those files are scanned directly;
   * otherwise the directory is walked recursively, respecting skip lists
   * and the `maxFiles` cap (default 5000).
   *
   * @param directory - Root directory to scan.
   * @param options   - Optional scan configuration.
   * @returns Sorted array of findings (critical first).
   */
  /** OPT-3.1: Read files concurrently in batches. */
  async function batchReadFiles(
    files: string[],
    concurrency = 20,
  ): Promise<[string, string][]> {
    const results: [string, string][] = []
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency)
      const reads = await Promise.all(
        batch.map(async (f) => {
          try {
            return [f, await fs.readFile(f, "utf-8")] as [string, string]
          } catch {
            return null
          }
        }),
      )
      for (const r of reads) {
        if (r) results.push(r)
      }
    }
    return results
  }

  /** Collect file paths without reading content. */
  async function collectFilePaths(
    directory: string,
    maxFiles: number,
  ): Promise<string[]> {
    const filePaths: string[] = []
    const walk = async (dir: string) => {
      if (filePaths.length >= maxFiles) return
      let entries: import("fs").Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (filePaths.length >= maxFiles) break
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_PATHS.includes(entry.name)) {
            await walk(fullPath)
          }
        } else if (entry.isFile()) {
          if (!shouldSkipFile(fullPath)) {
            filePaths.push(fullPath)
          }
        }
      }
    }
    await walk(directory)
    return filePaths
  }

  export async function scan(
    directory: string,
    options?: ScanOptions,
  ): Promise<Finding[]> {
    const findings: Finding[] = []
    const maxFiles = options?.maxFiles ?? 5000

    if (options?.files) {
      // OPT-3.1: Batch read specific files concurrently
      const contents = await batchReadFiles(options.files)
      for (const [file, content] of contents) {
        findings.push(...scanFile(content, file, options))
      }
      return sortFindings(findings)
    }

    // OPT-3.1: Collect paths first, then batch-read concurrently
    const filePaths = await collectFilePaths(directory, maxFiles)
    const contents = await batchReadFiles(filePaths)
    for (const [file, content] of contents) {
      findings.push(...scanFile(content, file, options))
    }

    log.info("scanned", {
      directory,
      files: filePaths.length,
      findings: findings.length,
    })
    return sortFindings(findings)
  }

  // ---------------------------------------------------------------------------
  // Sorting & formatting
  // ---------------------------------------------------------------------------

  /**
   * Sort findings by severity (critical first), then by file path and line.
   *
   * @param findings - Unordered findings array.
   * @returns The same array, sorted in place.
   */
  function sortFindings(findings: Finding[]): Finding[] {
    const severityOrder: Record<Severity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    }
    return findings.sort((a, b) => {
      const s = severityOrder[a.severity] - severityOrder[b.severity]
      if (s !== 0) return s
      return a.file.localeCompare(b.file) || a.line - b.line
    })
  }

  /**
   * Format findings as a human-readable report.
   *
   * @param findings   - Array of findings to format.
   * @param relativeTo - If provided, file paths are shown relative to this directory.
   * @returns Multi-line string summarising all findings.
   */
  export function format(findings: Finding[], relativeTo?: string): string {
    if (findings.length === 0) return "No secrets detected."

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const f of findings) bySeverity[f.severity]++

    const lines: string[] = [
      `Found ${findings.length} potential secret(s):`,
      `  Critical: ${bySeverity.critical}, High: ${bySeverity.high}, Medium: ${bySeverity.medium}, Low: ${bySeverity.low}`,
      "",
    ]

    for (const f of findings) {
      const file = relativeTo ? path.relative(relativeTo, f.file) : f.file
      const desc =
        patterns.find((p) => p.id === f.pattern)?.description ?? f.pattern
      lines.push(
        `[${f.severity.toUpperCase()}] ${desc} — ${file}:${f.line}`,
      )
      lines.push(`  ${f.snippet}`)
      lines.push("")
    }

    return lines.join("\n")
  }
}
