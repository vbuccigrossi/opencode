export namespace Token {
  const CHARS_PER_TOKEN_DEFAULT = 4
  const CHARS_PER_TOKEN_CLAUDE_PROSE = 3.5
  const CHARS_PER_TOKEN_CLAUDE_CODE = 2.5

  /**
   * Estimates token count using a generic chars/token ratio.
   * Default ratio: 4 chars/token (conservative, works for most models).
   *
   * @param input - Text to estimate
   * @returns Estimated token count
   */
  export function estimate(input: string): number {
    return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN_DEFAULT))
  }

  /**
   * Estimates token count with model-family-aware ratios.
   *
   * Claude tokenizes more densely than the generic 4:1 ratio:
   * - English prose: ~3.5 chars/token
   * - Code: ~2.5 chars/token
   *
   * @param input - Text to estimate
   * @param modelID - Model identifier (used to detect family)
   * @param mode - "prose" or "code" for Claude-family models
   * @returns Estimated token count
   */
  export function estimateForModel(input: string, modelID?: string, mode?: "prose" | "code"): number {
    if (!input) return 0
    const ratio = getCharsPerToken(modelID, mode)
    return Math.max(0, Math.round(input.length / ratio))
  }

  /**
   * Returns the chars-per-token ratio for a given model family.
   */
  function getCharsPerToken(modelID?: string, mode?: "prose" | "code"): number {
    if (!modelID) return CHARS_PER_TOKEN_DEFAULT
    const id = modelID.toLowerCase()
    if (id.includes("claude") || id.includes("anthropic")) {
      return mode === "code" ? CHARS_PER_TOKEN_CLAUDE_CODE : CHARS_PER_TOKEN_CLAUDE_PROSE
    }
    return CHARS_PER_TOKEN_DEFAULT
  }
}
