import { Log } from "../util/log"
import { Config } from "../config/config"

/**
 * Model alias system for quick model switching.
 *
 * Provides human-friendly shortcuts like "fast", "smart", "code"
 * that map to specific provider/model combinations. Users can
 * override defaults or add custom aliases in their config.
 */
export namespace ModelAlias {
  const log = Log.create({ service: "model.alias" })

  /** Built-in default aliases mapping friendly names to provider/model IDs. */
  const DEFAULTS: Record<string, string> = {
    // Speed-optimized
    fast: "anthropic/claude-haiku-4-5-20251001",
    quick: "anthropic/claude-haiku-4-5-20251001",

    // Intelligence-optimized
    smart: "anthropic/claude-opus-4-6",
    best: "anthropic/claude-opus-4-6",

    // Balanced
    balanced: "anthropic/claude-sonnet-4-6",
    code: "anthropic/claude-sonnet-4-6",
    default: "anthropic/claude-sonnet-4-6",

    // Cost-optimized
    cheap: "anthropic/claude-haiku-4-5-20251001",

    // OpenAI alternatives
    gpt: "openai/gpt-4.1",
    "gpt-mini": "openai/gpt-4.1-mini",
    o3: "openai/o3",

    // Google
    gemini: "google/gemini-2.5-pro",
    flash: "google/gemini-2.5-flash",
  }

  /**
   * Resolve a model alias to a full provider/model ID.
   *
   * Resolution order:
   * 1. User-defined aliases from config (model_aliases field)
   * 2. Built-in default aliases
   * 3. If no alias matches, return the input unchanged (assume it's already a full ID)
   *
   * @param input - Alias name or full model ID (e.g. "fast" or "anthropic/claude-sonnet-4-6")
   * @returns Resolved provider/model ID string
   */
  export async function resolve(input: string): Promise<string> {
    const normalized = input.trim().toLowerCase()

    // Check user-defined aliases first (may fail outside Instance context)
    try {
      const config = await Config.get()
      const userAliases = (config as any).model_aliases as Record<string, string> | undefined
      if (userAliases && normalized in userAliases) {
        const resolved = userAliases[normalized]
        log.info("resolved user alias", { alias: normalized, model: resolved })
        return resolved
      }
    } catch {
      // No Instance context — skip user aliases
    }

    // Check built-in defaults
    if (normalized in DEFAULTS) {
      const resolved = DEFAULTS[normalized]
      log.info("resolved built-in alias", { alias: normalized, model: resolved })
      return resolved
    }

    // Not an alias — return as-is (it's presumably a full model ID)
    return input
  }

  /**
   * Check if a string is a known alias (user-defined or built-in).
   *
   * @param input - String to check
   * @returns true if it's a recognized alias
   */
  export async function isAlias(input: string): Promise<boolean> {
    const normalized = input.trim().toLowerCase()
    try {
      const config = await Config.get()
      const userAliases = (config as any).model_aliases as Record<string, string> | undefined
      if (userAliases !== undefined && normalized in userAliases) return true
    } catch {
      // No Instance context — skip user aliases
    }
    return normalized in DEFAULTS
  }

  /**
   * List all available aliases (user-defined override built-ins).
   *
   * @returns Map of alias name to provider/model ID
   */
  export async function list(): Promise<Record<string, string>> {
    let userAliases: Record<string, string> | undefined
    try {
      const config = await Config.get()
      userAliases = (config as any).model_aliases as Record<string, string> | undefined
    } catch {
      // No Instance context — skip user aliases
    }
    return { ...DEFAULTS, ...(userAliases ?? {}) }
  }

  /**
   * Get only the built-in default aliases.
   *
   * @returns Map of alias name to provider/model ID
   */
  export function defaults(): Record<string, string> {
    return { ...DEFAULTS }
  }
}
