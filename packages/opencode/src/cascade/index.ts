import { Log } from "@/util/log"
import { CascadeTransforms } from "./transforms"
import { readFile, writeFile } from "fs/promises"

/**
 * Signature cascade engine — when a function's signature changes,
 * automatically propagates the change to all call sites.
 *
 * Uses the knowledge graph to find callers, then applies call-site
 * transforms (add/remove/reorder/rename parameters) across all
 * affected files atomically.
 */
export namespace Cascade {
  const log = Log.create({ service: "cascade" })

  /** Re-export types. */
  export type TransformType = CascadeTransforms.TransformType
  export type TransformDetails = CascadeTransforms.TransformDetails

  /** A single file affected by the cascade. */
  export interface AffectedFile {
    filePath: string
    originalContent: string
    newContent: string
    callSites: CascadeTransforms.TransformResult[]
  }

  /** A cascade plan ready for preview/apply. */
  export interface CascadePlan {
    id: string
    symbolName: string
    transform: CascadeTransforms.TransformDetails
    affectedFiles: AffectedFile[]
    status: "planned" | "applied" | "failed"
    createdAt: number
  }

  /** All cascade plans. */
  const plans = new Map<string, CascadePlan>()
  let counter = 0

  /**
   * Create a cascade plan by finding all callers and computing edits.
   *
   * @param symbolName - Function/method name whose signature changed
   * @param transform - What changed about the signature
   * @param callerFiles - Files that contain calls to this function
   *                      (typically from Graph.callersOf → unique file paths)
   * @returns The cascade plan with all affected files and edits
   */
  export async function plan(
    symbolName: string,
    transform: CascadeTransforms.TransformDetails,
    callerFiles: string[],
  ): Promise<CascadePlan> {
    const id = `cascade-${++counter}`
    const affectedFiles: AffectedFile[] = []

    for (const filePath of callerFiles) {
      try {
        const content = await readFile(filePath, "utf-8")
        const { results, newContent } = CascadeTransforms.transformCallSites(
          content,
          symbolName,
          transform,
        )

        if (results.length > 0 && newContent !== content) {
          affectedFiles.push({
            filePath,
            originalContent: content,
            newContent,
            callSites: results,
          })
        }
      } catch (err: any) {
        log.warn("cascade: failed to read file", { filePath, error: err.message })
      }
    }

    const cascadePlan: CascadePlan = {
      id,
      symbolName,
      transform,
      affectedFiles,
      status: "planned",
      createdAt: Date.now(),
    }

    plans.set(id, cascadePlan)
    log.info("cascade plan created", {
      id,
      symbolName,
      transform: transform.type,
      filesAffected: affectedFiles.length,
      totalCallSites: affectedFiles.reduce((sum, f) => sum + f.callSites.length, 0),
    })

    return cascadePlan
  }

  /**
   * Preview a cascade plan as a human-readable diff.
   *
   * @param planId - Cascade plan ID
   * @returns Formatted preview string
   */
  export function preview(planId: string): string {
    const p = plans.get(planId)
    if (!p) return `Cascade plan not found: ${planId}`

    if (p.affectedFiles.length === 0) {
      return `No call sites found for '${p.symbolName}'. No changes needed.`
    }

    const lines: string[] = []
    lines.push(`Cascade plan ${p.id}: ${p.transform.type} on '${p.symbolName}'`)
    lines.push(`${p.affectedFiles.length} file(s), ${p.affectedFiles.reduce((s, f) => s + f.callSites.length, 0)} call site(s)`)
    lines.push("")

    for (const file of p.affectedFiles) {
      lines.push(`--- ${file.filePath}`)
      for (const site of file.callSites) {
        lines.push(`  Line ${site.line}: ${site.description}`)
        lines.push(`    - ${site.original}`)
        lines.push(`    + ${site.transformed}`)
      }
      lines.push("")
    }

    return lines.join("\n")
  }

  /**
   * Apply a cascade plan — write all file changes to disk.
   *
   * @param planId - Cascade plan ID
   * @returns Number of files written
   */
  export async function apply(planId: string): Promise<number> {
    const p = plans.get(planId)
    if (!p) throw new Error(`Cascade plan not found: ${planId}`)
    if (p.status !== "planned") throw new Error(`Cascade plan ${planId} is ${p.status}`)

    let written = 0
    try {
      for (const file of p.affectedFiles) {
        await writeFile(file.filePath, file.newContent, "utf-8")
        written++
      }
      p.status = "applied"
      log.info("cascade applied", { id: planId, filesWritten: written })
    } catch (err: any) {
      p.status = "failed"
      log.error("cascade apply failed", { id: planId, error: err.message, filesWritten: written })
      throw err
    }

    return written
  }

  /**
   * Get a cascade plan by ID.
   *
   * @param planId - Cascade plan ID
   * @returns The plan, or undefined
   */
  export function get(planId: string): CascadePlan | undefined {
    return plans.get(planId)
  }

  /**
   * List all cascade plans.
   *
   * @returns All plans
   */
  export function list(): CascadePlan[] {
    return [...plans.values()]
  }

  /**
   * Format a plan summary.
   *
   * @param planId - Cascade plan ID
   * @returns Human-readable summary
   */
  export function format(planId: string): string {
    const p = plans.get(planId)
    if (!p) return `Cascade plan not found: ${planId}`

    const totalSites = p.affectedFiles.reduce((s, f) => s + f.callSites.length, 0)
    return `Cascade ${p.id} [${p.status}]: ${p.transform.type} on '${p.symbolName}' — ${p.affectedFiles.length} file(s), ${totalSites} call site(s)`
  }

  /**
   * Clear all cascade plans.
   */
  export function clearAll(): void {
    plans.clear()
    counter = 0
  }
}
