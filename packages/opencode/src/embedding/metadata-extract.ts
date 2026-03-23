import { Log } from "@/util/log"
import type { Chunker } from "./chunker"

/**
 * Security-focused metadata extraction from file chunks.
 *
 * Extracts structured metadata (CVE IDs, MITRE ATT&CK IDs, severity,
 * affected software) from security research files during indexing.
 * This metadata is stored alongside embeddings and used for:
 * - FTS keyword search enrichment
 * - Result grouping and prioritization
 * - Context formatting for the LLM
 */
export namespace MetadataExtract {
  const log = Log.create({ service: "embedding.metadata" })

  /** Extracted metadata from a chunk. */
  export interface ChunkMetadata {
    /** CVE identifiers found in this chunk. */
    cves: string[]
    /** MITRE ATT&CK technique IDs. */
    attackIDs: string[]
    /** Severity level if detected. */
    severity: string | null
    /** Affected software/products. */
    affectedSoftware: string[]
    /** General classification tags. */
    tags: string[]
    /** Content category for grouping. */
    category: "detection-rule" | "exploit" | "writeup" | "code" | "config" | "documentation"
  }

  /** Regex patterns for metadata extraction. */
  const PATTERNS = {
    cve: /CVE-\d{4}-\d{4,}/gi,
    attackID: /\bT\d{4}(?:\.\d{3})?\b/g,
    severity: /\b(?:severity|level|priority|risk)\s*[:=]\s*(critical|high|medium|low|info(?:rmational)?)\b/gi,
    sigmaSeverity: /^\s*level\s*:\s*(critical|high|medium|low|informational)\s*$/gim,
    suricataSid: /\bsid\s*:\s*(\d+)/gi,
    suricataMsg: /\bmsg\s*:\s*"([^"]+)"/gi,
    suricataClasstype: /\bclasstype\s*:\s*([\w-]+)/gi,
    suricataRef: /\breference\s*:\s*(?:cve|url|bugtraq)\s*,\s*([^;]+)/gi,
    yaraRule: /\brule\s+(\w+)/g,
    yaraMeta: /meta\s*:\s*([\s\S]*?)(?=strings\s*:|condition\s*:|rule\s|\})/gi,
    sigmaTitle: /^\s*title\s*:\s*(.+)$/gim,
    sigmaId: /^\s*id\s*:\s*([a-f0-9-]+)$/gim,
    sigmaTags: /^\s*-\s*attack\.([\w.]+)$/gim,
    affected: /\b(?:affected|vulnerable|target)\s*[:=]?\s*([^\n,;]+)/gi,
  }

  /**
   * Extract metadata from a chunk based on its content and file type.
   *
   * @param chunk - Chunk to analyze
   * @returns Extracted metadata
   */
  export function extract(chunk: Chunker.Chunk): ChunkMetadata {
    const content = chunk.content
    const ext = chunk.extension.toLowerCase()

    const meta: ChunkMetadata = {
      cves: extractCVEs(content),
      attackIDs: extractAttackIDs(content),
      severity: null,
      affectedSoftware: [],
      tags: [],
      category: categorize(ext, content, chunk.filePath),
    }

    // Extension-specific extraction
    if (ext === ".rule" || ext === ".rules") {
      extractSuricataSnort(content, meta)
    } else if (ext === ".yar" || ext === ".yara") {
      extractYara(content, meta)
    } else if (ext === ".sigma") {
      extractSigma(content, meta)
    }

    // Generic severity extraction for any file type
    if (!meta.severity) {
      meta.severity = extractSeverity(content)
    }

    // Extract affected software mentions
    const affected = extractAffected(content)
    if (affected.length > 0) {
      meta.affectedSoftware = affected
    }

    return meta
  }

  /**
   * Format metadata as a searchable string for FTS indexing.
   *
   * @param meta - Extracted metadata
   * @returns Space-separated string of all metadata values
   */
  export function formatForFTS(meta: ChunkMetadata): string {
    const parts: string[] = []
    if (meta.cves.length > 0) parts.push(meta.cves.join(" "))
    if (meta.attackIDs.length > 0) parts.push(meta.attackIDs.join(" "))
    if (meta.severity) parts.push(meta.severity)
    if (meta.affectedSoftware.length > 0) parts.push(meta.affectedSoftware.join(" "))
    if (meta.tags.length > 0) parts.push(meta.tags.join(" "))
    parts.push(meta.category)
    return parts.join(" ")
  }

  /**
   * Format metadata as a concise display string for the LLM context.
   *
   * @param meta - Extracted metadata
   * @returns Formatted string or empty if no metadata
   */
  export function formatForDisplay(meta: ChunkMetadata): string {
    const parts: string[] = []
    if (meta.cves.length > 0) parts.push(`CVEs: ${meta.cves.join(", ")}`)
    if (meta.attackIDs.length > 0) parts.push(`ATT&CK: ${meta.attackIDs.join(", ")}`)
    if (meta.severity) parts.push(`Severity: ${meta.severity}`)
    if (meta.affectedSoftware.length > 0) parts.push(`Affected: ${meta.affectedSoftware.join(", ")}`)
    if (meta.tags.length > 0) parts.push(`Tags: ${meta.tags.join(", ")}`)
    return parts.join("  |  ")
  }

  // ── Extraction helpers ──

  function extractCVEs(content: string): string[] {
    const matches = content.match(PATTERNS.cve)
    return matches ? [...new Set(matches.map((m) => m.toUpperCase()))] : []
  }

  function extractAttackIDs(content: string): string[] {
    const matches = content.match(PATTERNS.attackID)
    return matches ? [...new Set(matches)] : []
  }

  function extractSeverity(content: string): string | null {
    PATTERNS.severity.lastIndex = 0
    const match = PATTERNS.severity.exec(content)
    if (match) return match[1].toLowerCase()

    PATTERNS.sigmaSeverity.lastIndex = 0
    const sigmaMatch = PATTERNS.sigmaSeverity.exec(content)
    if (sigmaMatch) return sigmaMatch[1].toLowerCase()

    return null
  }

  function extractAffected(content: string): string[] {
    const results: string[] = []
    PATTERNS.affected.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATTERNS.affected.exec(content)) !== null) {
      const cleaned = match[1].trim()
      if (cleaned.length > 2 && cleaned.length < 100) {
        results.push(cleaned)
      }
    }
    return [...new Set(results)]
  }

  function extractSuricataSnort(content: string, meta: ChunkMetadata): void {
    // Extract SID
    PATTERNS.suricataSid.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATTERNS.suricataSid.exec(content)) !== null) {
      meta.tags.push(`sid:${match[1]}`)
    }

    // Extract message
    PATTERNS.suricataMsg.lastIndex = 0
    while ((match = PATTERNS.suricataMsg.exec(content)) !== null) {
      meta.tags.push(match[1])
    }

    // Extract classtype
    PATTERNS.suricataClasstype.lastIndex = 0
    while ((match = PATTERNS.suricataClasstype.exec(content)) !== null) {
      meta.tags.push(`classtype:${match[1]}`)
    }

    // Extract references (may contain CVE IDs)
    PATTERNS.suricataRef.lastIndex = 0
    while ((match = PATTERNS.suricataRef.exec(content)) !== null) {
      const ref = match[1].trim()
      if (/^\d{4}-\d{4,}$/.test(ref)) {
        meta.cves.push(`CVE-${ref}`)
      }
    }
    meta.cves = [...new Set(meta.cves)]
  }

  function extractYara(content: string, meta: ChunkMetadata): void {
    // Extract rule names
    PATTERNS.yaraRule.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATTERNS.yaraRule.exec(content)) !== null) {
      meta.tags.push(`yara:${match[1]}`)
    }

    // Extract metadata from meta: sections
    PATTERNS.yaraMeta.lastIndex = 0
    while ((match = PATTERNS.yaraMeta.exec(content)) !== null) {
      const metaBlock = match[1]
      // Look for author, description, severity, etc.
      const descMatch = metaBlock.match(/description\s*=\s*"([^"]+)"/i)
      if (descMatch) meta.tags.push(descMatch[1])

      const severityMatch = metaBlock.match(/severity\s*=\s*"?(\w+)"?/i)
      if (severityMatch && !meta.severity) {
        meta.severity = severityMatch[1].toLowerCase()
      }
    }
  }

  function extractSigma(content: string, meta: ChunkMetadata): void {
    // Extract title
    PATTERNS.sigmaTitle.lastIndex = 0
    const titleMatch = PATTERNS.sigmaTitle.exec(content)
    if (titleMatch) meta.tags.push(titleMatch[1].trim())

    // Extract severity level
    PATTERNS.sigmaSeverity.lastIndex = 0
    const levelMatch = PATTERNS.sigmaSeverity.exec(content)
    if (levelMatch) meta.severity = levelMatch[1].toLowerCase()

    // Extract ATT&CK tags from sigma format (- attack.t1059.001)
    PATTERNS.sigmaTags.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATTERNS.sigmaTags.exec(content)) !== null) {
      const tag = match[1]
      // Convert attack.t1059_001 or attack.t1059.001 to T1059.001
      const tidMatch = tag.match(/t(\d{4})(?:[._](\d{3}))?/i)
      if (tidMatch) {
        const tid = tidMatch[2] ? `T${tidMatch[1]}.${tidMatch[2]}` : `T${tidMatch[1]}`
        meta.attackIDs.push(tid)
      }
    }
    meta.attackIDs = [...new Set(meta.attackIDs)]
  }

  /**
   * Categorize a chunk based on file extension, content, and file path.
   *
   * Enhanced detection for documentation files:
   * - Files under a `.docs/` directory → "documentation"
   * - Files with `type: documentation` YAML frontmatter → "documentation"
   * - Markdown files with doc-like headings (## Functions, ## Types, ## Overview)
   *
   * @param ext - File extension (lowercase, with dot)
   * @param content - Chunk content
   * @param filePath - Optional file path for directory-based detection
   * @returns Category string
   */
  function categorize(ext: string, content: string, filePath?: string): ChunkMetadata["category"] {
    // Files under a .docs/ directory are always documentation
    if (filePath && /[/\\]\.docs[/\\]/.test(filePath)) {
      return "documentation"
    }

    // YAML frontmatter with type: documentation
    if (/^---\s*\n[\s\S]*?type:\s*documentation[\s\S]*?\n---/m.test(content)) {
      return "documentation"
    }

    // Detection rules
    if ([".rule", ".rules", ".yar", ".yara", ".sigma"].includes(ext)) {
      return "detection-rule"
    }

    // Documentation/writeups
    if ([".md", ".mdx", ".txt", ".rst", ".adoc"].includes(ext)) {
      // Check if it looks like a security writeup
      if (PATTERNS.cve.test(content)) return "writeup"
      // Check for API documentation patterns
      if (/^##\s+(?:Functions|Types|Overview|Constants|Variables|Methods|Examples)\s*$/m.test(content)) {
        return "documentation"
      }
      return "documentation"
    }

    // Exploit/security code
    if ([".py", ".rb", ".go", ".c", ".cpp", ".rs", ".java", ".sh"].includes(ext)) {
      if (/exploit|payload|shellcode|reverse.?shell|bind.?shell|buffer.?overflow/i.test(content)) {
        return "exploit"
      }
      if (PATTERNS.cve.test(content)) return "exploit"
      return "code"
    }

    // Config files
    if ([".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg"].includes(ext)) {
      return "config"
    }

    return "code"
  }
}
