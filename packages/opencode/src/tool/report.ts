import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Artifact } from "../artifact"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

/**
 * Report tool — creates and manages structured output artifacts.
 *
 * Produces persistent documents (security audits, architecture reviews,
 * refactoring plans, checklists) that survive compaction and can be
 * exported to the filesystem.
 */
export const ReportTool = Tool.define("report", async () => ({
  description: `Create and manage structured reports, checklists, and plans that persist across the session.

Operations:
- create: Create a new report with a title, type, and initial content
- append: Add a section to an existing report
- update_section: Replace content under a specific heading
- checklist_check: Mark a checklist item as done/blocked/skipped/pending
- checklist_progress: Show completion stats for a checklist
- finalize: Mark a report as complete and export to filesystem
- list: Show all reports in the current session
- read: Read the full content of a report

Report types:
- report: General-purpose report (security audit, code review, architecture review)
- checklist: Task list with checkable items and priority levels
- plan: Implementation plan with steps and milestones
- notebook: Free-form notes and observations
- diff_summary: Summary of changes made during a session

Reports persist across compaction (stored outside the message stream).
Use finalize to export a report to .cortex/reports/ as a markdown file.`,
  parameters: z.object({
    operation: z
      .enum([
        "create",
        "append",
        "update_section",
        "checklist_check",
        "checklist_progress",
        "finalize",
        "list",
        "read",
      ])
      .describe("The report operation to perform"),
    title: z.string().optional().describe("Report title (required for create)"),
    type: z
      .enum(["report", "checklist", "plan", "notebook", "diff_summary"])
      .optional()
      .describe("Report type (for create, default: report)"),
    content: z.string().optional().describe("Content to add (for create, append)"),
    report_id: z.string().optional().describe("Report ID (for append, update_section, finalize, read, checklist ops)"),
    heading: z.string().optional().describe("Section heading (for update_section)"),
    item_index: z.number().optional().describe("Checklist item number (1-based, for checklist_check)"),
    item_status: z
      .enum(["done", "pending", "blocked", "skipped"])
      .optional()
      .describe("New status (for checklist_check)"),
    notes: z.string().optional().describe("Notes to attach (for checklist_check)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "create":
        return reportCreate(params, ctx)
      case "append":
        return reportAppend(params)
      case "update_section":
        return reportUpdateSection(params)
      case "checklist_check":
        return reportChecklistCheck(params)
      case "checklist_progress":
        return reportChecklistProgress(params)
      case "finalize":
        return await reportFinalize(params)
      case "list":
        return reportList(ctx)
      case "read":
        return reportRead(params)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.report" })

/** Create a new report. */
function reportCreate(
  params: { title?: string; type?: string; content?: string },
  ctx: Tool.Context,
): { title: string; metadata: Record<string, any>; output: string } {
  if (!params.title) throw new Error("title parameter is required for create operation")

  const type = (params.type ?? "report") as Artifact.ArtifactType
  const content = params.content ?? getTemplate(type, params.title)

  const artifact = Artifact.create({
    sessionID: ctx.sessionID,
    type,
    title: params.title,
    content,
  })

  return {
    title: `report: created "${params.title}"`,
    metadata: { reportID: artifact.id, type },
    output: `Created ${type} "${params.title}" (ID: ${artifact.id}).\n\nUse report_id="${artifact.id}" to append, update, or finalize this report.`,
  }
}

/** Append content to a report. */
function reportAppend(
  params: { report_id?: string; content?: string },
): { title: string; metadata: Record<string, any>; output: string } {
  if (!params.report_id) throw new Error("report_id parameter is required for append operation")
  if (!params.content) throw new Error("content parameter is required for append operation")

  const artifact = Artifact.append(params.report_id, "\n\n" + params.content)
  return {
    title: `report: appended to "${artifact.title}"`,
    metadata: { reportID: artifact.id, length: artifact.content.length },
    output: `Appended to "${artifact.title}". Report is now ${artifact.content.length} characters.`,
  }
}

/** Update a section of a report. */
function reportUpdateSection(
  params: { report_id?: string; heading?: string; content?: string },
): { title: string; metadata: Record<string, any>; output: string } {
  if (!params.report_id) throw new Error("report_id parameter is required")
  if (!params.heading) throw new Error("heading parameter is required")
  if (!params.content) throw new Error("content parameter is required")

  const artifact = Artifact.updateSection(params.report_id, params.heading, params.content)
  return {
    title: `report: updated "${params.heading}"`,
    metadata: { reportID: artifact.id },
    output: `Updated section "${params.heading}" in "${artifact.title}".`,
  }
}

/** Check/uncheck a checklist item. */
function reportChecklistCheck(
  params: { report_id?: string; item_index?: number; item_status?: string; notes?: string },
): { title: string; metadata: Record<string, any>; output: string } {
  if (!params.report_id) throw new Error("report_id parameter is required")
  if (!params.item_index) throw new Error("item_index parameter is required")
  if (!params.item_status) throw new Error("item_status parameter is required")

  const items = Artifact.checkItem(
    params.report_id,
    params.item_index,
    params.item_status as Artifact.ChecklistItem["status"],
    params.notes,
  )

  const progress = Artifact.checklistProgress(params.report_id)
  return {
    title: `report: checked item ${params.item_index}`,
    metadata: { reportID: params.report_id, progress },
    output: `Item ${params.item_index} marked as ${params.item_status}. Progress: ${progress.done}/${progress.total} (${progress.percentage}%)`,
  }
}

/** Get checklist progress. */
function reportChecklistProgress(
  params: { report_id?: string },
): { title: string; metadata: Record<string, any>; output: string } {
  if (!params.report_id) throw new Error("report_id parameter is required")

  const progress = Artifact.checklistProgress(params.report_id)
  const items = Artifact.parseChecklist(params.report_id)

  const pending = items.filter((i) => i.status === "pending")
  const blocked = items.filter((i) => i.status === "blocked")

  const sections: string[] = [
    `Progress: ${progress.done}/${progress.total} (${progress.percentage}%)`,
    `Done: ${progress.done}, Pending: ${progress.pending}, Blocked: ${progress.blocked}, Skipped: ${progress.skipped}`,
  ]

  if (pending.length > 0) {
    sections.push(`\nPending items:\n${pending.map((i) => `  ${i.id}. [P${i.priority}] ${i.text}`).join("\n")}`)
  }
  if (blocked.length > 0) {
    sections.push(`\nBlocked items:\n${blocked.map((i) => `  ${i.id}. ${i.text}${i.notes ? ` — ${i.notes}` : ""}`).join("\n")}`)
  }

  return {
    title: "report: checklist progress",
    metadata: { reportID: params.report_id, progress },
    output: sections.join("\n"),
  }
}

/** Finalize and export a report. */
async function reportFinalize(
  params: { report_id?: string },
): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.report_id) throw new Error("report_id parameter is required")

  const artifact = await Artifact.finalize(params.report_id)
  return {
    title: `report: finalized "${artifact.title}"`,
    metadata: {
      reportID: artifact.id,
      exportPath: artifact.exportPath,
    },
    output: `Finalized "${artifact.title}". Exported to: ${artifact.exportPath}`,
  }
}

/** List all reports. */
function reportList(
  ctx: Tool.Context,
): { title: string; metadata: Record<string, any>; output: string } {
  const all = Artifact.list(ctx.sessionID)

  if (all.length === 0) {
    return {
      title: "report: list",
      metadata: { count: 0 },
      output: "No reports in this session.",
    }
  }

  const lines = all.map((a) => {
    const status = a.finalized ? "finalized" : "draft"
    const size = a.content.length
    return `${a.id} [${a.type}] "${a.title}" — ${status}, ${size} chars${a.exportPath ? `, exported to ${path.relative(Instance.directory, a.exportPath)}` : ""}`
  })

  return {
    title: "report: list",
    metadata: { count: all.length },
    output: `${all.length} report(s):\n\n${lines.join("\n")}`,
  }
}

/** Read a report's full content. */
function reportRead(
  params: { report_id?: string },
): { title: string; metadata: Record<string, any>; output: string } {
  if (!params.report_id) throw new Error("report_id parameter is required")

  const artifact = Artifact.get(params.report_id)
  if (!artifact) throw new Error(`Report ${params.report_id} not found`)

  return {
    title: `report: "${artifact.title}"`,
    metadata: {
      reportID: artifact.id,
      type: artifact.type,
      finalized: artifact.finalized,
      length: artifact.content.length,
    },
    output: artifact.content,
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function getTemplate(type: Artifact.ArtifactType, title: string): string {
  switch (type) {
    case "report":
      return `# ${title}\n\n## Summary\n\n*Pending*\n\n## Findings\n\n*No findings yet.*\n\n## Recommendations\n\n*Pending analysis.*`
    case "checklist":
      return `# ${title}\n\n## Tasks\n\n- [ ] *Add checklist items*`
    case "plan":
      return `# ${title}\n\n## Overview\n\n*Describe the plan.*\n\n## Steps\n\n1. *First step*\n\n## Risks\n\n*Identify potential risks.*`
    case "notebook":
      return `# ${title}\n\n## Notes\n\n`
    case "diff_summary":
      return `# ${title}\n\n## Changes\n\n*No changes recorded yet.*`
    default:
      return `# ${title}\n\n`
  }
}
