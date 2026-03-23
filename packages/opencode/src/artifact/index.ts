import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Instance } from "../project/instance"

/**
 * Artifact system for structured, persistent output documents.
 *
 * Artifacts survive compaction (stored outside the message stream) and
 * can be exported to the filesystem. Used by the report tool for
 * security audits, architecture reviews, refactoring plans, etc.
 */
export namespace Artifact {
  const log = Log.create({ service: "artifact" })

  /** Artifact types. */
  export type ArtifactType = "report" | "notebook" | "checklist" | "plan" | "diff_summary"

  /** Artifact output formats. */
  export type ArtifactFormat = "markdown" | "json" | "html"

  /** A stored artifact. */
  export interface Info {
    /** Unique artifact ID. */
    id: string
    /** Session that created this artifact. */
    sessionID: string
    /** Artifact type. */
    type: ArtifactType
    /** Human-readable title. */
    title: string
    /** Output format. */
    format: ArtifactFormat
    /** Full content. */
    content: string
    /** When created (unix ms). */
    createdAt: number
    /** When last updated (unix ms). */
    updatedAt: number
    /** Whether the artifact is finalized. */
    finalized: boolean
    /** Export path (if exported). */
    exportPath?: string
  }

  /** Checklist item within a checklist artifact. */
  export interface ChecklistItem {
    /** Item ID (1-based). */
    id: number
    /** Item description. */
    text: string
    /** Current status. */
    status: "pending" | "done" | "blocked" | "skipped"
    /** Optional notes. */
    notes?: string
    /** Priority (1 = high, 3 = low). */
    priority: 1 | 2 | 3
  }

  let idCounter = 0
  const artifacts = new Map<string, Info>()

  /**
   * Create a new artifact.
   *
   * @param input - Artifact metadata and initial content
   * @returns The created artifact
   */
  export function create(input: {
    sessionID: string
    type: ArtifactType
    title: string
    content?: string
    format?: ArtifactFormat
  }): Info {
    const id = `art_${++idCounter}`
    const now = Date.now()
    const artifact: Info = {
      id,
      sessionID: input.sessionID,
      type: input.type,
      title: input.title,
      format: input.format ?? "markdown",
      content: input.content ?? "",
      createdAt: now,
      updatedAt: now,
      finalized: false,
    }
    artifacts.set(id, artifact)
    log.info("created", { id, type: input.type, title: input.title })
    return { ...artifact }
  }

  /**
   * Append content to an existing artifact.
   *
   * @param id - Artifact ID
   * @param content - Content to append
   * @returns Updated artifact
   */
  export function append(id: string, content: string): Info {
    const artifact = artifacts.get(id)
    if (!artifact) throw new Error(`Artifact ${id} not found`)
    if (artifact.finalized) throw new Error(`Artifact ${id} is finalized and cannot be modified`)
    artifact.content += content
    artifact.updatedAt = Date.now()
    return { ...artifact }
  }

  /**
   * Update a specific section of an artifact (by heading).
   *
   * Replaces the content under a markdown heading with new content.
   *
   * @param id - Artifact ID
   * @param heading - Heading text to find (e.g., "## Findings")
   * @param newContent - New content for that section
   * @returns Updated artifact
   */
  export function updateSection(id: string, heading: string, newContent: string): Info {
    const artifact = artifacts.get(id)
    if (!artifact) throw new Error(`Artifact ${id} not found`)
    if (artifact.finalized) throw new Error(`Artifact ${id} is finalized and cannot be modified`)

    const lines = artifact.content.split("\n")
    const headingLevel = heading.match(/^(#+)/)?.[1]?.length ?? 2
    const headingPattern = new RegExp(`^#{${headingLevel}}\\s+${escapeRegex(heading.replace(/^#+\s*/, ""))}`)

    let startIdx = -1
    let endIdx = lines.length

    for (let i = 0; i < lines.length; i++) {
      if (headingPattern.test(lines[i])) {
        startIdx = i
        // Find end: next heading at same or higher level
        for (let j = i + 1; j < lines.length; j++) {
          const nextHeading = lines[j].match(/^(#+)\s/)
          if (nextHeading && nextHeading[1].length <= headingLevel) {
            endIdx = j
            break
          }
        }
        break
      }
    }

    if (startIdx === -1) {
      // Heading not found — append as new section
      artifact.content += `\n\n${heading}\n\n${newContent}`
    } else {
      const before = lines.slice(0, startIdx)
      const after = lines.slice(endIdx)
      artifact.content = [...before, `${lines[startIdx]}`, "", newContent, "", ...after].join("\n")
    }

    artifact.updatedAt = Date.now()
    return { ...artifact }
  }

  /** Get an artifact by ID. */
  export function get(id: string): Info | undefined {
    const artifact = artifacts.get(id)
    return artifact ? { ...artifact } : undefined
  }

  /** List all artifacts for a session. */
  export function list(sessionID?: string): Info[] {
    const all = Array.from(artifacts.values())
    if (sessionID) {
      return all.filter((a) => a.sessionID === sessionID).map((a) => ({ ...a }))
    }
    return all.map((a) => ({ ...a }))
  }

  /**
   * Finalize an artifact and optionally export to filesystem.
   *
   * @param id - Artifact ID
   * @param exportPath - Optional custom export path
   * @returns The finalized artifact with export path
   */
  export async function finalize(id: string, exportPath?: string): Promise<Info> {
    const artifact = artifacts.get(id)
    if (!artifact) throw new Error(`Artifact ${id} not found`)

    artifact.finalized = true
    artifact.updatedAt = Date.now()

    // Add frontmatter for markdown
    if (artifact.format === "markdown" && !artifact.content.startsWith("---")) {
      const frontmatter = [
        "---",
        `title: "${artifact.title}"`,
        `type: ${artifact.type}`,
        `date: ${new Date(artifact.createdAt).toISOString()}`,
        `session: ${artifact.sessionID}`,
        "---",
        "",
      ].join("\n")
      artifact.content = frontmatter + artifact.content
    }

    // Export to filesystem
    const targetPath = exportPath ?? defaultExportPath(artifact)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, artifact.content, "utf-8")
    artifact.exportPath = targetPath

    log.info("finalized", { id, exportPath: targetPath })
    return { ...artifact }
  }

  /**
   * Export an artifact to a specific format.
   *
   * @param id - Artifact ID
   * @param format - Target format
   * @returns Formatted content string
   */
  export function exportAs(id: string, format: ArtifactFormat): string {
    const artifact = artifacts.get(id)
    if (!artifact) throw new Error(`Artifact ${id} not found`)

    switch (format) {
      case "markdown":
        return artifact.content
      case "json":
        return JSON.stringify(
          {
            title: artifact.title,
            type: artifact.type,
            createdAt: new Date(artifact.createdAt).toISOString(),
            updatedAt: new Date(artifact.updatedAt).toISOString(),
            content: artifact.content,
          },
          null,
          2,
        )
      case "html":
        return markdownToBasicHtml(artifact.title, artifact.content)
      default:
        return artifact.content
    }
  }

  // ---------------------------------------------------------------------------
  // Checklist helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse checklist items from artifact content.
   *
   * @param id - Artifact ID
   * @returns Parsed checklist items
   */
  export function parseChecklist(id: string): ChecklistItem[] {
    const artifact = artifacts.get(id)
    if (!artifact) throw new Error(`Artifact ${id} not found`)
    if (artifact.type !== "checklist") throw new Error(`Artifact ${id} is not a checklist`)

    const items: ChecklistItem[] = []
    const lines = artifact.content.split("\n")
    let itemId = 0

    for (const line of lines) {
      const match = line.match(/^- \[([ xX!-])\]\s*(?:\[P([1-3])\]\s*)?(.+)$/)
      if (match) {
        itemId++
        const statusChar = match[1]
        const priority = match[2] ? (parseInt(match[2]) as 1 | 2 | 3) : 2
        const text = match[3].trim()

        let status: ChecklistItem["status"] = "pending"
        if (statusChar === "x" || statusChar === "X") status = "done"
        else if (statusChar === "!") status = "blocked"
        else if (statusChar === "-") status = "skipped"

        items.push({ id: itemId, text, status, priority })
      }
    }

    return items
  }

  /**
   * Update a checklist item's status.
   *
   * @param artifactID - Artifact ID
   * @param itemIndex - 1-based item index
   * @param status - New status
   * @param notes - Optional notes
   * @returns Updated checklist items
   */
  export function checkItem(
    artifactID: string,
    itemIndex: number,
    status: ChecklistItem["status"],
    notes?: string,
  ): ChecklistItem[] {
    const artifact = artifacts.get(artifactID)
    if (!artifact) throw new Error(`Artifact ${artifactID} not found`)
    if (artifact.finalized) throw new Error(`Artifact ${artifactID} is finalized`)

    const lines = artifact.content.split("\n")
    let currentItem = 0

    for (let i = 0; i < lines.length; i++) {
      if (/^- \[[ xX!-]\]/.test(lines[i])) {
        currentItem++
        if (currentItem === itemIndex) {
          const statusChar =
            status === "done" ? "x" : status === "blocked" ? "!" : status === "skipped" ? "-" : " "
          lines[i] = lines[i].replace(/^- \[[ xX!-]\]/, `- [${statusChar}]`)
          if (notes) {
            lines[i] = lines[i].replace(/\s*—\s*.*$/, "") + ` — ${notes}`
          }
          break
        }
      }
    }

    artifact.content = lines.join("\n")
    artifact.updatedAt = Date.now()
    return parseChecklist(artifactID)
  }

  /**
   * Get checklist completion stats.
   *
   * @param id - Artifact ID
   * @returns Completion percentage and counts
   */
  export function checklistProgress(id: string): {
    total: number
    done: number
    pending: number
    blocked: number
    skipped: number
    percentage: number
  } {
    const items = parseChecklist(id)
    const done = items.filter((i) => i.status === "done").length
    const pending = items.filter((i) => i.status === "pending").length
    const blocked = items.filter((i) => i.status === "blocked").length
    const skipped = items.filter((i) => i.status === "skipped").length
    return {
      total: items.length,
      done,
      pending,
      blocked,
      skipped,
      percentage: items.length > 0 ? Math.round((done / items.length) * 100) : 0,
    }
  }

  /** Clear all artifacts (for testing). */
  export function clear() {
    artifacts.clear()
    idCounter = 0
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  function defaultExportPath(artifact: Info): string {
    const slug = artifact.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
    const date = new Date(artifact.createdAt).toISOString().slice(0, 10)
    const ext = artifact.format === "json" ? "json" : artifact.format === "html" ? "html" : "md"
    return path.join(Instance.directory, ".cortex", "reports", `${slug}-${date}.${ext}`)
  }

  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  function markdownToBasicHtml(title: string, content: string): string {
    let html = content
      // Headings
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      // Bold/italic
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // Code
      .replace(/`(.+?)`/g, "<code>$1</code>")
      // Checklist
      .replace(/^- \[x\] (.+)$/gm, '<li class="done">$1</li>')
      .replace(/^- \[ \] (.+)$/gm, '<li class="pending">$1</li>')
      // Lists
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      // Paragraphs
      .replace(/\n\n/g, "</p><p>")

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;max-width:800px;margin:2em auto;padding:0 1em}
.done{text-decoration:line-through;color:#666}.pending{color:#333}
code{background:#f4f4f4;padding:2px 4px;border-radius:3px}
h1,h2,h3{border-bottom:1px solid #eee;padding-bottom:0.3em}</style>
</head><body><p>${html}</p></body></html>`
  }
}
