import { Log } from "../util/log"
import fs from "fs/promises"
import path from "path"

export namespace SecurityPatterns {
  const log = Log.create({ service: "security.patterns" })

  export type Severity = "critical" | "high" | "medium" | "low" | "info"

  export type Category =
    | "injection"
    | "auth"
    | "crypto"
    | "path_traversal"
    | "info_disclosure"
    | "misconfiguration"
    | "xss"

  /** A security pattern finding. */
  export interface Finding {
    file: string
    line: number
    category: Category
    severity: Severity
    title: string
    description: string
    snippet: string
    remediation: string
  }

  /** A vulnerability detection pattern. */
  interface VulnPattern {
    id: string
    category: Category
    severity: Severity
    title: string
    description: string
    regex: RegExp
    remediation: string
    /** File extensions this pattern applies to (empty = all). */
    extensions?: string[]
    /** If set, a nearby line matching this pattern suppresses the finding (shows mitigation exists). */
    suppressIf?: RegExp
  }

  export interface ScanOptions {
    /** Specific files to scan. */
    files?: string[]
    /** Categories to scan (default: all). */
    categories?: Category[]
    /** Max files to scan. */
    maxFiles?: number
  }

  const PATTERNS: VulnPattern[] = [
    // ---- Injection ----
    {
      id: "sql-template-literal",
      category: "injection",
      severity: "critical",
      title: "SQL Injection via Template Literal",
      description: "SQL query constructed with template literals may allow SQL injection",
      regex: /(?:query|execute|raw|sql)\s*\(\s*`[^`]*\$\{/gi,
      remediation: "Use parameterized queries or prepared statements instead of template literals",
      extensions: [".ts", ".js", ".tsx", ".jsx"],
    },
    {
      id: "sql-string-concat",
      category: "injection",
      severity: "critical",
      title: "SQL Injection via String Concatenation",
      description: "SQL query built by concatenating user-controlled values",
      regex: /(?:query|execute|raw)\s*\(\s*["'][^"']*["']\s*\+/gi,
      remediation: "Use parameterized queries instead of string concatenation",
      extensions: [".ts", ".js", ".tsx", ".jsx", ".py"],
    },
    {
      id: "eval-usage",
      category: "injection",
      severity: "critical",
      title: "Eval Usage",
      description: "eval() executes arbitrary code and is a security risk",
      regex: /\beval\s*\(/g,
      remediation: "Avoid eval(). Use JSON.parse() for data, or Function constructor for controlled code generation",
      extensions: [".ts", ".js", ".tsx", ".jsx"],
      suppressIf: /\/\/\s*(?:eslint-disable|nosec|safe|trusted)/,
    },
    {
      id: "new-function",
      category: "injection",
      severity: "high",
      title: "Function Constructor",
      description: "new Function() is equivalent to eval() and executes arbitrary code",
      regex: /new\s+Function\s*\(/g,
      remediation: "Avoid new Function(). Use safer alternatives",
      extensions: [".ts", ".js", ".tsx", ".jsx"],
    },
    {
      id: "command-injection",
      category: "injection",
      severity: "critical",
      title: "Command Injection Risk",
      description: "Shell command constructed with template literals or concatenation",
      regex: /(?:exec|execSync|spawn|spawnSync)\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)/g,
      remediation: "Use spawn/execFile with argument arrays instead of shell string construction",
      extensions: [".ts", ".js", ".tsx", ".jsx"],
    },
    {
      id: "python-os-system",
      category: "injection",
      severity: "high",
      title: "OS Command Injection (Python)",
      description: "os.system() or os.popen() with variable input enables command injection",
      regex: /os\.(?:system|popen)\s*\(\s*(?:f["']|["']\s*%|["']\s*\+|\w+\s*\+)/g,
      remediation: "Use subprocess.run() with argument list instead of shell=True",
      extensions: [".py"],
    },

    // ---- XSS ----
    {
      id: "innerhtml",
      category: "xss",
      severity: "high",
      title: "innerHTML Assignment",
      description: "Direct innerHTML assignment can lead to XSS if content is user-controlled",
      regex: /\.innerHTML\s*[=+](?!=)/g,
      remediation: "Use textContent, or sanitize HTML with DOMPurify before assigning to innerHTML",
      extensions: [".ts", ".js", ".tsx", ".jsx"],
    },
    {
      id: "dangerously-set-html",
      category: "xss",
      severity: "high",
      title: "dangerouslySetInnerHTML",
      description: "React dangerouslySetInnerHTML bypasses XSS protection",
      regex: /dangerouslySetInnerHTML\s*=\s*\{/g,
      remediation: "Sanitize the HTML with DOMPurify before passing to dangerouslySetInnerHTML",
      extensions: [".tsx", ".jsx", ".ts", ".js"],
    },

    // ---- Auth/Crypto ----
    {
      id: "weak-hash-md5",
      category: "crypto",
      severity: "high",
      title: "Weak Hash Algorithm (MD5)",
      description: "MD5 is cryptographically broken and should not be used for security purposes",
      regex: /(?:createHash|hashlib\.md5|MD5|Digest::MD5)\s*\(\s*["']?md5["']?\s*\)/gi,
      remediation: "Use SHA-256 or stronger hash algorithms for security purposes",
    },
    {
      id: "weak-hash-sha1",
      category: "crypto",
      severity: "medium",
      title: "Weak Hash Algorithm (SHA1)",
      description: "SHA1 has known collision attacks and is deprecated for security use",
      regex: /(?:createHash|hashlib\.sha1)\s*\(\s*["']?sha1["']?\s*\)/gi,
      remediation: "Use SHA-256 or SHA-3 instead of SHA-1",
    },
    {
      id: "hardcoded-iv",
      category: "crypto",
      severity: "high",
      title: "Hardcoded Initialization Vector",
      description: "Using a hardcoded IV weakens encryption",
      regex: /(?:iv|nonce)\s*[:=]\s*(?:Buffer\.from|new Uint8Array|b["'])\s*\(/gi,
      remediation: "Generate IVs randomly using crypto.randomBytes() or equivalent",
      extensions: [".ts", ".js", ".py"],
    },
    {
      id: "permissive-cors",
      category: "auth",
      severity: "medium",
      title: "Permissive CORS Configuration",
      description: "CORS configured to allow all origins",
      regex: /(?:Access-Control-Allow-Origin|cors)\s*[:({]\s*["']\*["']/gi,
      remediation: "Restrict CORS to specific trusted origins instead of wildcard '*'",
    },
    {
      id: "csrf-disabled",
      category: "auth",
      severity: "high",
      title: "CSRF Protection Disabled",
      description: "CSRF protection appears to be explicitly disabled",
      regex: /(?:csrf|xsrf)\s*[:=]\s*(?:false|disabled|off)/gi,
      remediation: "Enable CSRF protection and use anti-CSRF tokens",
    },
    {
      id: "jwt-no-verify",
      category: "auth",
      severity: "critical",
      title: "JWT Without Verification",
      description: "JWT decoded without signature verification",
      regex: /jwt\.decode\s*\([^)]*(?:verify\s*[:=]\s*false|algorithms\s*[:=]\s*\[\s*["']none["'])/gi,
      remediation: "Always verify JWT signatures. Never accept 'none' algorithm",
    },

    // ---- Path Traversal ----
    {
      id: "path-traversal",
      category: "path_traversal",
      severity: "high",
      title: "Potential Path Traversal",
      description: "File path constructed from user input without sanitization",
      regex: /(?:readFile|writeFile|createReadStream|open)\s*\(\s*(?:req\.|params\.|query\.|body\.)/g,
      remediation:
        "Validate and sanitize file paths. Use path.resolve() and verify the result is within the expected directory",
      extensions: [".ts", ".js", ".tsx", ".jsx"],
    },
    {
      id: "python-path-traversal",
      category: "path_traversal",
      severity: "high",
      title: "Potential Path Traversal (Python)",
      description: "File opened with user-controlled path",
      regex: /open\s*\(\s*(?:request\.|args\.|kwargs\[)/g,
      remediation: "Validate paths using os.path.realpath() and check they're within allowed directories",
      extensions: [".py"],
    },

    // ---- Information Disclosure ----
    {
      id: "stack-trace-response",
      category: "info_disclosure",
      severity: "medium",
      title: "Stack Trace in Error Response",
      description: "Error stack trace may be exposed in HTTP responses",
      regex: /(?:res\.(?:send|json|write)|response\.(?:send|json))\s*\([^)]*(?:err\.stack|error\.stack|\.stackTrace)/g,
      remediation: "Log stack traces server-side. Return generic error messages to clients",
      extensions: [".ts", ".js"],
    },
    {
      id: "debug-mode",
      category: "info_disclosure",
      severity: "medium",
      title: "Debug Mode Enabled",
      description: "Debug mode should be disabled in production",
      regex: /(?:DEBUG|debug)\s*[:=]\s*(?:true|True|1|["'](?:true|yes|on)["'])/g,
      remediation: "Ensure debug mode is disabled in production configurations",
      suppressIf: /(?:test|development|dev|local)/i,
    },
    {
      id: "verbose-error",
      category: "info_disclosure",
      severity: "low",
      title: "Verbose Error Message",
      description: "Detailed error messages may leak internal information",
      regex: /catch\s*\([^)]*\)\s*\{[^}]*(?:res\.(?:send|json)|return\s+Response)\s*\([^)]*(?:err\.message|error\.message|e\.message)/gs,
      remediation: "Return generic error messages. Log details server-side",
      extensions: [".ts", ".js"],
    },

    // ---- Misconfiguration ----
    {
      id: "insecure-http",
      category: "misconfiguration",
      severity: "medium",
      title: "Insecure HTTP URL",
      description: "HTTP URL used instead of HTTPS for sensitive endpoint",
      regex: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|::1)[^\s"']+(?:api|auth|login|token|secret|password|pay)/gi,
      remediation: "Use HTTPS for all sensitive communications",
    },
    {
      id: "tls-reject-unauthorized",
      category: "misconfiguration",
      severity: "critical",
      title: "TLS Certificate Validation Disabled",
      description: "Disabling certificate validation makes HTTPS vulnerable to MITM attacks",
      regex: /(?:rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED)\s*[:=]\s*(?:false|0|["']0["'])/g,
      remediation: "Never disable TLS certificate validation in production",
    },
    {
      id: "permissive-permissions",
      category: "misconfiguration",
      severity: "medium",
      title: "Overly Permissive File Permissions",
      description: "File permissions set to 777 or world-writable",
      regex: /(?:chmod|mode)\s*[:=(]\s*(?:0?777|0o777|["']777["'])/g,
      remediation: "Use restrictive file permissions. Typically 644 for files, 755 for directories",
    },
    {
      id: "debug-endpoints",
      category: "misconfiguration",
      severity: "high",
      title: "Debug Endpoint Exposed",
      description: "Debug/admin endpoints may be accidentally exposed",
      regex: /(?:app|router)\.(?:get|post|all)\s*\(\s*["']\/(?:debug|admin|internal|_health|phpinfo|actuator)/g,
      remediation: "Protect debug/admin endpoints with authentication or remove in production",
      extensions: [".ts", ".js", ".py"],
    },
  ]

  /** File extensions to skip. */
  const SKIP_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".webp",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".zip",
    ".gz",
    ".tar",
    ".bz2",
    ".pdf",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".wasm",
    ".bin",
    ".lock",
    ".lockb",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
  ])

  const SKIP_PATHS = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    "__pycache__",
    "venv",
    ".venv",
    "target",
    ".opencode",
  ]

  function shouldSkipFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    if (SKIP_EXTENSIONS.has(ext)) return true
    return filePath.split(path.sep).some((p) => SKIP_PATHS.includes(p))
  }

  /**
   * Scan a single file for security patterns.
   *
   * Runs all applicable vulnerability regex patterns against each line of the file content.
   * Skips binary files, comment-only lines, and respects per-pattern extension filters
   * and suppression patterns.
   *
   * @param content - The file content as a string.
   * @param filePath - The absolute path of the file being scanned.
   * @param options - Optional scan options to filter by category.
   * @returns An array of Finding objects for each detected vulnerability pattern.
   */
  export function scanFile(content: string, filePath: string, options?: ScanOptions): Finding[] {
    if (shouldSkipFile(filePath)) return []

    const findings: Finding[] = []
    const ext = path.extname(filePath).toLowerCase()
    const lines = content.split("\n")
    const categories = options?.categories ? new Set(options.categories) : null

    for (const pattern of PATTERNS) {
      if (categories && !categories.has(pattern.category)) continue
      if (pattern.extensions && !pattern.extensions.includes(ext)) continue

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]

        // Skip comment-only lines
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue

        pattern.regex.lastIndex = 0
        if (pattern.regex.test(line)) {
          // Check suppression pattern (look within 3 lines above and below)
          if (pattern.suppressIf) {
            let suppressed = false
            for (let j = Math.max(0, lineIdx - 3); j <= Math.min(lines.length - 1, lineIdx + 3); j++) {
              if (pattern.suppressIf.test(lines[j])) {
                suppressed = true
                break
              }
            }
            if (suppressed) continue
          }

          findings.push({
            file: filePath,
            line: lineIdx + 1,
            category: pattern.category,
            severity: pattern.severity,
            title: pattern.title,
            description: pattern.description,
            snippet: trimmed.substring(0, 120),
            remediation: pattern.remediation,
          })
        }
      }
    }

    return findings
  }

  /**
   * Scan a directory for security patterns.
   *
   * Recursively walks the directory tree, reading each file and running scanFile()
   * against it. Skips binary extensions, common non-source directories (node_modules,
   * .git, dist, etc.), and respects the maxFiles limit.
   *
   * @param directory - The root directory to scan.
   * @param options - Optional scan options (file list, category filter, max files).
   * @returns A sorted array of Finding objects, ordered by severity then file/line.
   */
  /** OPT-3.1: Read files concurrently in batches. */
  async function batchReadFiles(files: string[], concurrency = 20): Promise<[string, string][]> {
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

  async function collectFilePaths(directory: string, maxFiles: number): Promise<string[]> {
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
          if (!SKIP_PATHS.includes(entry.name)) await walk(fullPath)
        } else if (entry.isFile()) {
          if (!shouldSkipFile(fullPath)) filePaths.push(fullPath)
        }
      }
    }
    await walk(directory)
    return filePaths
  }

  export async function scan(directory: string, options?: ScanOptions): Promise<Finding[]> {
    const findings: Finding[] = []
    const maxFiles = options?.maxFiles ?? 5000

    if (options?.files) {
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

    log.info("scanned", { directory, files: filePaths.length, findings: findings.length })
    return sortFindings(findings)
  }

  /**
   * Sort findings by severity (critical first), then by file path and line number.
   *
   * @param findings - The unsorted array of findings.
   * @returns The sorted array (sorted in place).
   */
  function sortFindings(findings: Finding[]): Finding[] {
    const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    return findings.sort((a, b) => {
      const s = severityOrder[a.severity] - severityOrder[b.severity]
      if (s !== 0) return s
      return a.file.localeCompare(b.file) || a.line - b.line
    })
  }

  /**
   * Format findings as a readable report.
   *
   * Groups findings by category, shows severity counts in a summary header,
   * and includes the code snippet and remediation advice for each finding.
   *
   * @param findings - The findings to format.
   * @param relativeTo - If provided, file paths are shown relative to this directory.
   * @returns A formatted multi-line string report.
   */
  export function format(findings: Finding[], relativeTo?: string): string {
    if (findings.length === 0) return "No security pattern issues detected."

    const bySev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const f of findings) bySev[f.severity]++

    const byCat = new Map<Category, Finding[]>()
    for (const f of findings) {
      const arr = byCat.get(f.category) ?? []
      arr.push(f)
      byCat.set(f.category, arr)
    }

    const lines: string[] = [
      `Found ${findings.length} security pattern issue(s):`,
      `  Critical: ${bySev.critical}, High: ${bySev.high}, Medium: ${bySev.medium}, Low: ${bySev.low}`,
      "",
    ]

    for (const [cat, catFindings] of byCat) {
      lines.push(`### ${cat.replace("_", " ").toUpperCase()}`)
      for (const f of catFindings) {
        const file = relativeTo ? path.relative(relativeTo, f.file) : f.file
        lines.push(`[${f.severity.toUpperCase()}] ${f.title} — ${file}:${f.line}`)
        lines.push(`  ${f.snippet}`)
        lines.push(`  → ${f.remediation}`)
        lines.push("")
      }
    }

    return lines.join("\n")
  }

  /**
   * Get all available vulnerability categories.
   *
   * @returns A deduplicated array of Category values from the built-in pattern set.
   */
  export function categories(): Category[] {
    return [...new Set(PATTERNS.map((p) => p.category))]
  }
}
