import { VerifyEngine } from "./engine"
import { VerifyDetect } from "./detect"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Config } from "@/config/config"

/**
 * Verification module — runs typecheck, lint, test, and build commands
 * after edits and returns structured error reports.
 *
 * Auto-detects project tooling from package manifests.
 * Provides both automatic post-edit verification and an explicit
 * agent tool for targeted verification.
 */
export namespace Verify {
  const log = Log.create({ service: "verify" })

  export type Commands = VerifyDetect.Commands
  export type StepResult = VerifyEngine.StepResult
  export type VerifyResult = VerifyEngine.VerifyResult
  export type VerifyError = VerifyEngine.VerifyError
  export type ProjectType = VerifyDetect.ProjectType

  /** Cached detected commands per directory */
  const commandCache = new Map<string, VerifyDetect.Commands>()

  /**
   * Gets the verification commands for the current project.
   * Results are cached per directory.
   *
   * @param directory - Project root (defaults to Instance.worktree)
   * @returns Detected commands
   */
  export function commands(directory?: string): VerifyDetect.Commands {
    const dir = directory ?? Instance.worktree
    const cached = commandCache.get(dir)
    if (cached) return cached

    const detected = VerifyDetect.detect(dir)
    commandCache.set(dir, detected)
    log.info("detected verification commands", { directory: dir, commands: detected })
    return detected
  }

  /**
   * Runs a typecheck on the project.
   *
   * @param directory - Project root (defaults to Instance.worktree)
   * @returns Typecheck result
   */
  export async function typecheck(directory?: string): Promise<VerifyEngine.StepResult | undefined> {
    const dir = directory ?? Instance.worktree
    const cmds = commands(dir)
    if (!cmds.typecheck) return undefined

    const result = await VerifyEngine.run(dir, {
      typecheck: true,
      lint: false,
      test: false,
      build: false,
      commands: cmds,
    })

    return result.steps[0]
  }

  /**
   * Runs the full verification pipeline.
   *
   * @param config - What to verify and how
   * @returns Full verification result
   */
  export async function run(config?: VerifyEngine.VerifyConfig): Promise<VerifyEngine.VerifyResult> {
    const dir = Instance.worktree
    const appConfig = await Config.get()
    const stepTimeouts = appConfig.experimental?.verify_timeouts
    return VerifyEngine.run(dir, {
      commands: commands(dir),
      ...(stepTimeouts ? { stepTimeouts } : {}),
      ...config,
    })
  }

  /**
   * Formats a verification result into a human-readable string.
   */
  export function format(result: VerifyEngine.VerifyResult): string {
    return VerifyEngine.format(result)
  }
}
