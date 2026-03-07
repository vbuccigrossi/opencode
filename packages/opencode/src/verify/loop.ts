import { Verify } from "."
import { VerifyEngine } from "./engine"
import { VerifyDetect } from "./detect"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Graph } from "@/graph"

/**
 * Verification loop — automatically runs verification after edits and
 * formats structured errors for re-injection into the agent conversation.
 *
 * Tracks repair attempts per session to prevent infinite repair loops.
 * When edits are detected (via PatchParts), runs typecheck and optionally
 * other verification steps. If errors are found, formats them into a
 * system-level prompt that the agent can act on to self-repair.
 */
export namespace VerifyLoop {
  const log = Log.create({ service: "verify.loop" })

  /** Default maximum number of auto-repair iterations per turn. */
  const DEFAULT_MAX_REPAIRS = 3

  /** Per-session state tracking repair attempts within a single user turn. */
  interface SessionState {
    /** Number of repair attempts in the current turn. */
    repairCount: number
    /** Files that had errors on the last verification. */
    lastErrorFiles: Set<string>
    /** The user message ID that started this turn (for reset tracking). */
    turnMessageID: string
  }

  const sessions = new Map<string, SessionState>()

  /**
   * Resets the repair counter for a session.
   * Call this when a new user message starts a turn.
   *
   * @param sessionID - Session identifier
   * @param userMessageID - The user message that started this turn
   */
  export function resetTurn(sessionID: string, userMessageID: string): void {
    const existing = sessions.get(sessionID)
    if (existing && existing.turnMessageID === userMessageID) return
    sessions.set(sessionID, {
      repairCount: 0,
      lastErrorFiles: new Set(),
      turnMessageID: userMessageID,
    })
  }

  /**
   * Cleans up state for a session.
   *
   * @param sessionID - Session identifier
   */
  export function cleanup(sessionID: string): void {
    sessions.delete(sessionID)
  }

  /**
   * Checks if automatic verification should run after file changes.
   *
   * Returns false if:
   * - Auto-verify is disabled in config
   * - No verification commands are detected for the project
   * - The repair limit has been reached for this turn
   *
   * @param sessionID - Session identifier
   * @returns Whether verification should run
   */
  export async function shouldVerify(sessionID: string): Promise<boolean> {
    const config = await Config.get()
    if (config.experimental?.auto_verify === false) return false

    const maxRepairs = config.experimental?.max_auto_repairs ?? DEFAULT_MAX_REPAIRS
    const state = sessions.get(sessionID)
    if (state && state.repairCount >= maxRepairs) {
      log.info("repair limit reached", {
        sessionID,
        repairCount: state.repairCount,
        maxRepairs,
      })
      return false
    }

    try {
      const cmds = Verify.commands()
      return !!cmds.typecheck
    } catch {
      return false
    }
  }

  /**
   * Runs verification after edits and returns formatted errors for the agent.
   *
   * Runs typecheck (and optionally other steps based on config).
   * If all checks pass, returns undefined.
   * If errors are found, increments the repair counter and returns
   * a formatted error block suitable for injection as a system reminder.
   *
   * @param sessionID - Session identifier
   * @param changedFiles - Files that were modified in this step
   * @returns Formatted error block, or undefined if verification passed
   */
  export async function verify(
    sessionID: string,
    changedFiles: string[],
  ): Promise<string | undefined> {
    const config = await Config.get()
    const state = sessions.get(sessionID)

    log.info("running post-edit verification", {
      sessionID,
      changedFiles,
      repairCount: state?.repairCount ?? 0,
    })

    try {
      // OPT-4.1: Batch graph impact analysis — collect all node names first, then query once
      let targetFiles: string[] = [...changedFiles]
      try {
        const projectID = Instance.project.id
        const allNodeNames: string[] = []
        for (const file of changedFiles) {
          const nodes = Graph.nodesInFile(projectID, file)
          for (const node of nodes.slice(0, 10)) {
            allNodeNames.push(node.name)
          }
        }
        // Deduplicate and batch impact queries
        const uniqueNames = [...new Set(allNodeNames)]
        const affectedSet = new Set(targetFiles)
        for (const name of uniqueNames) {
          const impact = Graph.impactOf(projectID, name, 2)
          for (const f of impact.affectedFiles) {
            affectedSet.add(f)
          }
        }
        targetFiles = [...affectedSet]
      } catch {
        // Graph not available — fall back to changed files only
      }

      const targeting = VerifyDetect.targetingSupport(Instance.worktree)
      const useTargeted = targeting.typecheck && targetFiles.length > 0 && targetFiles.length <= 20

      const result = await Verify.run({
        typecheck: true,
        lint: false,
        test: config.experimental?.auto_verify_test === true,
        build: false,
        timeout: 30_000,
        files: useTargeted ? targetFiles : undefined,
        targeted: useTargeted,
      })

      if (result.success) {
        log.info("verification passed", { sessionID })
        if (state) {
          state.lastErrorFiles.clear()
        }
        return undefined
      }

      // Track repair attempt
      if (state) {
        state.repairCount++
        state.lastErrorFiles = new Set(
          result.steps
            .flatMap((s) => s.errors)
            .map((e) => e.file)
            .filter((f): f is string => !!f),
        )
      }

      const maxRepairs = config.experimental?.max_auto_repairs ?? DEFAULT_MAX_REPAIRS
      const remaining = maxRepairs - (state?.repairCount ?? 1)

      return formatVerificationErrors(result, changedFiles, remaining)
    } catch (err) {
      log.warn("verification failed to run", { error: err })
      return undefined
    }
  }

  /**
   * Formats verification errors into a system reminder block
   * for injection into the agent's conversation.
   *
   * @param result - Verification result with errors
   * @param changedFiles - Files that were just modified
   * @param remainingAttempts - How many auto-repair attempts remain
   * @returns Formatted error block
   */
  function formatVerificationErrors(
    result: VerifyEngine.VerifyResult,
    changedFiles: string[],
    remainingAttempts: number,
  ): string {
    const sections: string[] = []

    sections.push("<verification-errors>")
    sections.push("Automatic verification detected errors after your edits.")
    sections.push("")

    for (const step of result.steps) {
      if (step.success) continue

      const errors = step.errors.filter((e) => e.severity === "error").slice(0, 15)
      sections.push(`${step.step} FAILED (${errors.length} error${errors.length !== 1 ? "s" : ""}):`)

      for (const error of errors) {
        const loc = error.file
          ? `${error.file}${error.line ? `:${error.line}` : ""}${error.column ? `:${error.column}` : ""}`
          : "(unknown)"
        sections.push(`  ${loc}: ${error.code ? `[${error.code}] ` : ""}${error.message}`)
      }
      sections.push("")
    }

    if (changedFiles.length > 0) {
      sections.push(`Files changed: ${changedFiles.join(", ")}`)
    }

    if (remainingAttempts > 0) {
      sections.push("")
      sections.push(
        `Please fix these errors. You have ${remainingAttempts} automatic repair attempt${remainingAttempts !== 1 ? "s" : ""} remaining.`,
      )
    } else {
      sections.push("")
      sections.push(
        "This is your last automatic repair attempt. Fix the errors or inform the user if you cannot resolve them.",
      )
    }

    sections.push("</verification-errors>")

    return sections.join("\n")
  }

  /**
   * Returns the current repair count for a session.
   *
   * @param sessionID - Session identifier
   * @returns Current repair count, or 0 if no state exists
   */
  export function repairCount(sessionID: string): number {
    return sessions.get(sessionID)?.repairCount ?? 0
  }
}
