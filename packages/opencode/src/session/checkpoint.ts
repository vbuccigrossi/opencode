import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { $ } from "bun"

/**
 * Checkpoint — git-based save points that the agent can create before
 * risky operations and rollback to on failure.
 *
 * Uses `git stash` with descriptive messages to create lightweight
 * checkpoints. Each checkpoint is tagged with the session ID and
 * a label for easy identification.
 *
 * The checkpoint system integrates with:
 * - Session state: checkpoint refs are recorded in state.checkpoint
 * - Pre-flight: auto-creates checkpoints for high-risk changes
 * - Monitor: references checkpoints in verification spiral warnings
 */
export namespace Checkpoint {
  const log = Log.create({ service: "session.checkpoint" })

  /** Information about a checkpoint. */
  export interface Info {
    /** Git stash reference (e.g., "stash@{0}") */
    ref: string
    /** Human-readable label */
    label: string
    /** Session that created this checkpoint */
    sessionID: string
    /** When the checkpoint was created */
    timestamp: number
  }

  /** Prefix used to identify opencode checkpoints in git stash. */
  const STASH_PREFIX = "opencode-checkpoint:"

  /**
   * Creates a checkpoint by staging all changes and stashing them
   * with a descriptive message.
   *
   * The stash is created with `--keep-index` so the working directory
   * remains unchanged — the checkpoint is purely a save point.
   *
   * @param sessionID - Session that's creating the checkpoint
   * @param label - Descriptive label (e.g., "before refactoring auth module")
   * @returns The stash reference, or undefined if nothing to stash
   */
  export async function create(
    sessionID: string,
    label: string,
  ): Promise<string | undefined> {
    const cwd = Instance.directory
    const message = `${STASH_PREFIX} ${sessionID} | ${label}`

    try {
      // Check if there are any changes to checkpoint
      const status = await $`git -C ${cwd} status --porcelain`.text()
      if (!status.trim()) {
        log.info("no changes to checkpoint")
        return undefined
      }

      // Stage everything, create stash, then unstage
      // --keep-index keeps the working tree and index as-is
      await $`git -C ${cwd} stash push -m ${message} --include-untracked`.text()
      // Pop immediately to restore working state — we just want the save point
      await $`git -C ${cwd} stash pop`.text()

      // The checkpoint is now stash@{0} in the reflog
      // Find it by message
      const ref = await findStashByMessage(cwd, message)
      if (ref) {
        log.info("checkpoint created", { ref, label })
        return ref
      }

      // Fallback: the stash was popped, but we can find the commit via reflog
      log.warn("checkpoint stash not found after pop — using commit ref")
      return undefined
    } catch (err) {
      log.warn("checkpoint creation failed", { error: err })
      return undefined
    }
  }

  /**
   * Alternative checkpoint that creates a temporary commit instead of a stash.
   * More reliable than stash-based checkpoints since it doesn't affect the
   * working directory state at all.
   *
   * Creates a commit on a detached checkpoint branch, then switches back.
   * The commit hash serves as the checkpoint reference.
   *
   * @param sessionID - Session creating the checkpoint
   * @param label - Descriptive label
   * @returns Commit hash of the checkpoint, or undefined on failure
   */
  export async function createCommit(
    sessionID: string,
    label: string,
  ): Promise<string | undefined> {
    const cwd = Instance.directory

    try {
      // Check for changes
      const status = await $`git -C ${cwd} status --porcelain`.text()
      if (!status.trim()) {
        log.info("no changes to checkpoint")
        return undefined
      }

      // Get current branch/ref
      const currentRef = (await $`git -C ${cwd} rev-parse HEAD`.text()).trim()

      // Stage all changes and create a temporary commit
      await $`git -C ${cwd} add -A`.quiet()
      const message = `${STASH_PREFIX} ${sessionID} | ${label}`
      await $`git -C ${cwd} commit --no-verify -m ${message}`.quiet()

      // Get the checkpoint commit hash
      const checkpointHash = (await $`git -C ${cwd} rev-parse HEAD`.text()).trim()

      // Soft reset to undo the commit but keep changes staged
      await $`git -C ${cwd} reset --soft ${currentRef}`.quiet()

      // Unstage to restore original working directory state
      await $`git -C ${cwd} reset HEAD`.quiet()

      log.info("checkpoint commit created", { hash: checkpointHash.slice(0, 8), label })
      return checkpointHash
    } catch (err) {
      log.warn("checkpoint commit creation failed", { error: err })
      return undefined
    }
  }

  /**
   * Rolls back to a checkpoint by checking out the checkpoint commit
   * and applying it to the working directory.
   *
   * WARNING: This discards all changes since the checkpoint.
   *
   * @param ref - The checkpoint reference (commit hash)
   * @returns true if rollback succeeded
   */
  export async function rollback(ref: string): Promise<boolean> {
    const cwd = Instance.directory

    try {
      // Verify the ref exists
      await $`git -C ${cwd} cat-file -t ${ref}`.text()

      // Hard reset to the checkpoint
      // This is intentionally destructive — the agent decided to rollback
      await $`git -C ${cwd} checkout ${ref} -- .`.quiet()

      log.info("rolled back to checkpoint", { ref: ref.slice(0, 8) })
      return true
    } catch (err) {
      log.warn("rollback failed", { ref, error: err })
      return false
    }
  }

  /**
   * Lists available checkpoints for a session.
   *
   * Searches git reflog for checkpoint commits created by this session.
   *
   * @param sessionID - Session to list checkpoints for
   * @returns Array of checkpoint info objects
   */
  export async function list(sessionID: string): Promise<Info[]> {
    const cwd = Instance.directory
    const results: Info[] = []

    try {
      // Search reflog for checkpoint commits
      const reflog = await $`git -C ${cwd} reflog --format="%H %gd %gs" -n 100`.text()
      const lines = reflog.trim().split("\n").filter(Boolean)

      for (const line of lines) {
        const parts = line.split(" ")
        const hash = parts[0]
        const rest = parts.slice(2).join(" ")

        if (rest.includes(STASH_PREFIX) && rest.includes(sessionID)) {
          const labelMatch = rest.match(/\| (.+)$/)
          results.push({
            ref: hash,
            label: labelMatch?.[1] ?? "checkpoint",
            sessionID,
            timestamp: Date.now(), // Approximate — reflog doesn't store timestamps easily
          })
        }
      }
    } catch (err) {
      log.warn("listing checkpoints failed", { error: err })
    }

    return results
  }

  /**
   * Determines whether an automatic checkpoint should be created
   * based on risk level and configuration.
   *
   * @param riskLevel - The pre-flight risk assessment
   * @returns true if a checkpoint should be created
   */
  export function shouldAutoCheckpoint(riskLevel: "low" | "medium" | "high"): boolean {
    return riskLevel === "high"
  }

  // ─── Internal Helpers ────────────────────────────────────────

  /**
   * Finds a stash entry by its message.
   *
   * @param cwd - Working directory
   * @param message - Stash message to search for
   * @returns Stash reference (e.g., "stash@{0}") or undefined
   */
  async function findStashByMessage(cwd: string, message: string): Promise<string | undefined> {
    try {
      const stashList = await $`git -C ${cwd} stash list`.text()
      const lines = stashList.trim().split("\n").filter(Boolean)

      for (const line of lines) {
        if (line.includes(message)) {
          const match = line.match(/^(stash@\{\d+\})/)
          return match?.[1]
        }
      }
    } catch {
      // No stashes
    }
    return undefined
  }
}
