import { Graph } from "@/graph"
import { Instance } from "@/project/instance"
import { Verify } from "@/verify"
import { Log } from "@/util/log"

/**
 * Edit planning — provides structured impact analysis before edits begin.
 *
 * When the agent is about to edit files, the planning module can analyze
 * the impact of those changes using the knowledge graph and provide
 * a structured impact assessment including:
 * - Callers/dependents that may be affected
 * - Related test files
 * - Verification commands available
 *
 * This information is injected as context to help the agent make
 * better editing decisions.
 */
export namespace EditPlanning {
  const log = Log.create({ service: "agent.planning" })

  /** Impact analysis for a planned edit. */
  export interface EditImpact {
    /** Symbols being modified */
    targetSymbols: string[]
    /** Direct callers of the modified symbols */
    directCallers: Array<{ name: string; kind: string; filePath: string; line: number }>
    /** Files that transitively depend on the modified symbols */
    affectedFiles: string[]
    /** Test files that may need updating */
    affectedTests: Array<{ name: string; filePath: string; line: number }>
    /** Available verification commands */
    verifyCommands: Verify.Commands
  }

  /**
   * Analyzes the impact of editing specific symbols or files.
   *
   * @param symbols - Symbol names being modified
   * @param files - File paths being modified
   * @returns Impact analysis
   */
  export function analyzeImpact(symbols: string[], files: string[]): EditImpact {
    const projectID = Instance.project.id
    const directCallers: EditImpact["directCallers"] = []
    const affectedFilesSet = new Set<string>()
    const affectedTests: EditImpact["affectedTests"] = []
    const seenCallers = new Set<string>()

    for (const symbol of symbols) {
      const impact = Graph.impactOf(projectID, symbol, 3)

      for (const caller of impact.directDependents) {
        if (!seenCallers.has(caller.id)) {
          seenCallers.add(caller.id)
          directCallers.push({
            name: caller.name,
            kind: caller.kind,
            filePath: caller.filePath,
            line: caller.startLine,
          })
        }
      }

      for (const file of impact.affectedFiles) {
        affectedFilesSet.add(file)
      }

      for (const test of impact.affectedTests) {
        affectedTests.push({
          name: test.name,
          filePath: test.filePath,
          line: test.startLine,
        })
      }
    }

    // Add files being directly modified
    for (const file of files) {
      affectedFilesSet.add(file)
    }

    const verifyCommands = Verify.commands()

    return {
      targetSymbols: symbols,
      directCallers,
      affectedFiles: [...affectedFilesSet],
      affectedTests,
      verifyCommands,
    }
  }

  /**
   * Formats an impact analysis into a human-readable string
   * suitable for injection into the agent prompt.
   *
   * @param impact - Impact analysis result
   * @returns Formatted string
   */
  export function formatImpact(impact: EditImpact): string {
    const sections: string[] = []

    if (impact.directCallers.length > 0) {
      const callerLines = impact.directCallers
        .slice(0, 15)
        .map((c) => `  ${c.kind} ${c.name} at ${c.filePath}:${c.line}`)
      sections.push(
        `Direct callers that may be affected (${impact.directCallers.length}):\n${callerLines.join("\n")}` +
          (impact.directCallers.length > 15 ? `\n  ... and ${impact.directCallers.length - 15} more` : ""),
      )
    }

    if (impact.affectedTests.length > 0) {
      const testLines = impact.affectedTests
        .slice(0, 10)
        .map((t) => `  ${t.name} at ${t.filePath}:${t.line}`)
      sections.push(
        `Related tests (${impact.affectedTests.length}):\n${testLines.join("\n")}`,
      )
    }

    if (impact.affectedFiles.length > 0) {
      sections.push(
        `Affected files (${impact.affectedFiles.length}):\n${impact.affectedFiles.slice(0, 20).map((f) => `  ${f}`).join("\n")}`,
      )
    }

    const verifyEntries = Object.entries(impact.verifyCommands).filter(([_, v]) => v)
    if (verifyEntries.length > 0) {
      sections.push(
        `Available verification:\n${verifyEntries.map(([step, cmd]) => `  ${step}: ${cmd}`).join("\n")}` +
          `\n  Tip: Use the 'verify' tool after editing to check for errors.`,
      )
    }

    if (sections.length === 0) {
      return "No impact data available (graph may not be indexed)."
    }

    return `Edit impact analysis for ${impact.targetSymbols.join(", ")}:\n\n${sections.join("\n\n")}`
  }
}
