import { Log } from "@/util/log"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { generateText } from "ai"
import { Filesystem } from "@/util/filesystem"
import path from "path"
import { Instance } from "@/project/instance"

/**
 * Dual-model code routing for local ollama setups.
 *
 * When a planning model (e.g. Devstral-Small) decides to write/edit code,
 * the CodeRouter intercepts the tool call and delegates actual code generation
 * to a dedicated coding model (e.g. Qwen2.5-Coder 32B).
 *
 * The planner decides WHAT to change; the coder decides HOW.
 *
 * Architecture:
 *   Devstral (planner) → calls edit/write tool with intent
 *     → CodeRouter intercepts
 *     → Sends focused prompt + file context to Qwen (coder)
 *     → Qwen returns code only
 *     → Optional self-check pass
 *     → Returns rewritten parameters to tool execution
 *
 * Enabled via config:
 *   { "experimental": { "coder_model": "ollama/qwen2.5-coder:32b-instruct-q4_K_M" } }
 */
export namespace CodeRouter {
  const log = Log.create({ service: "code-router" })

  /** Maximum file content to send to the coder model (chars). */
  const MAX_FILE_CONTEXT = 12_000

  /** Maximum tokens for code generation response. */
  const MAX_CODE_TOKENS = 4096

  /** Timeout for a single Qwen call (ms). */
  const CALL_TIMEOUT_MS = 120_000

  /** Tools that produce code and should be routed to the coder model. */
  const CODE_TOOLS = new Set(["edit", "write"])

  /**
   * Check if dual-model routing is enabled and configured.
   *
   * @returns The coder model info if configured, undefined otherwise.
   */
  export async function getCoderModel(): Promise<Provider.Model | undefined> {
    const cfg = await Config.get()
    const coderSpec = cfg.experimental?.coder_model
    if (!coderSpec || typeof coderSpec !== "string") return undefined

    const slash = coderSpec.indexOf("/")
    if (slash === -1) return undefined

    const providerID = coderSpec.slice(0, slash)
    const modelID = coderSpec.slice(slash + 1)

    try {
      return await Provider.getModel(providerID as any, modelID as any)
    } catch {
      log.warn("coder model not found, falling back to planner", {
        coder: coderSpec,
      })
      return undefined
    }
  }

  /**
   * Check if a tool call should be routed to the coder model.
   *
   * @param toolId - The tool being called (e.g. "edit", "write", "bash").
   * @param plannerModel - The current session's planner model.
   * @returns true if this tool call should go through the coder.
   */
  export function shouldRoute(toolId: string, plannerModel: Provider.Model): boolean {
    // Only route for ollama planner models
    if (plannerModel.providerID !== "ollama") return false
    return CODE_TOOLS.has(toolId)
  }

  /**
   * Route an edit tool call through the coder model.
   *
   * Takes Devstral's edit parameters (which may have poor code quality),
   * reads the target file, sends both to Qwen with context about the
   * intended change, and returns improved parameters.
   *
   * @param params - Original edit tool parameters from the planner.
   * @param context - Planner's reasoning context (recent conversation).
   * @param coderModel - The coding model to use.
   * @returns Rewritten edit parameters with Qwen-generated code.
   */
  export async function routeEdit(
    params: { filePath: string; oldString: string; newString: string; replaceAll?: boolean },
    context: string,
    coderModel: Provider.Model,
  ): Promise<{ filePath: string; oldString: string; newString: string; replaceAll?: boolean }> {
    const filePath = path.isAbsolute(params.filePath)
      ? params.filePath
      : path.join(Instance.directory, params.filePath)

    // Read current file content for context
    let fileContent = ""
    try {
      fileContent = await Filesystem.readText(filePath)
      if (fileContent.length > MAX_FILE_CONTEXT) {
        // Find the region around oldString and provide surrounding context
        const idx = fileContent.indexOf(params.oldString)
        if (idx !== -1) {
          const start = Math.max(0, idx - 2000)
          const end = Math.min(fileContent.length, idx + params.oldString.length + 2000)
          fileContent =
            (start > 0 ? "...\n" : "") +
            fileContent.slice(start, end) +
            (end < fileContent.length ? "\n..." : "")
        } else {
          fileContent = fileContent.slice(0, MAX_FILE_CONTEXT) + "\n..."
        }
      }
    } catch {
      // File doesn't exist yet or can't be read — proceed with what we have
    }

    const prompt = buildEditPrompt(params, fileContent, context)

    log.info("routing edit to coder model", {
      file: params.filePath,
      coderModel: coderModel.id,
      oldStringLen: params.oldString.length,
      newStringLen: params.newString.length,
    })

    const result = await callCoder(coderModel, prompt)
    if (!result) {
      log.warn("coder model returned empty, using planner's code")
      return params
    }

    // Extract the code from the response
    const newString = extractCode(result, params.newString)

    // Self-check: ask the coder to verify its own output
    const verified = await selfCheck(coderModel, {
      filePath: params.filePath,
      fileContent,
      oldString: params.oldString,
      newString,
      context,
    })

    return {
      ...params,
      newString: verified,
    }
  }

  /**
   * Route a write tool call through the coder model.
   *
   * @param params - Original write tool parameters from the planner.
   * @param context - Planner's reasoning context.
   * @param coderModel - The coding model to use.
   * @returns Rewritten write parameters with Qwen-generated code.
   */
  export async function routeWrite(
    params: { filePath: string; content: string },
    context: string,
    coderModel: Provider.Model,
  ): Promise<{ filePath: string; content: string }> {
    const prompt = buildWritePrompt(params, context)

    log.info("routing write to coder model", {
      file: params.filePath,
      coderModel: coderModel.id,
      contentLen: params.content.length,
    })

    const result = await callCoder(coderModel, prompt)
    if (!result) {
      log.warn("coder model returned empty, using planner's code")
      return params
    }

    const content = extractCode(result, params.content)

    // Self-check
    const verified = await selfCheck(coderModel, {
      filePath: params.filePath,
      fileContent: "",
      oldString: "",
      newString: content,
      context,
    })

    return {
      ...params,
      content: verified,
    }
  }

  /**
   * Build the prompt for an edit operation.
   * Gives Qwen the file content, the region to change, and the planner's intent.
   */
  function buildEditPrompt(
    params: { filePath: string; oldString: string; newString: string },
    fileContent: string,
    context: string,
  ): string {
    const ext = path.extname(params.filePath).slice(1) || "txt"
    return `You are a code generation engine. Your ONLY job is to produce correct, clean code.

TASK: Edit a section of code in \`${params.filePath}\`.

CONTEXT FROM PLANNER:
${context}

CURRENT FILE CONTENT:
\`\`\`${ext}
${fileContent}
\`\`\`

SECTION TO REPLACE (old code):
\`\`\`${ext}
${params.oldString}
\`\`\`

PLANNER'S SUGGESTED REPLACEMENT:
\`\`\`${ext}
${params.newString}
\`\`\`

INSTRUCTIONS:
- Write the REPLACEMENT code that should go where the old code was.
- The replacement must be a drop-in substitute — same indentation, same style as surrounding code.
- Fix any bugs, type errors, or issues in the planner's suggestion.
- Do NOT include the old code in your response.
- Do NOT add explanations, comments about what you changed, or markdown formatting.
- Output ONLY the replacement code, nothing else.
- If the planner's suggestion looks correct, return it unchanged.

REPLACEMENT CODE:`
  }

  /**
   * Build the prompt for a write (new file) operation.
   */
  function buildWritePrompt(
    params: { filePath: string; content: string },
    context: string,
  ): string {
    const ext = path.extname(params.filePath).slice(1) || "txt"
    return `You are a code generation engine. Your ONLY job is to produce correct, clean code.

TASK: Write the complete contents of a new file \`${params.filePath}\`.

CONTEXT FROM PLANNER:
${context}

PLANNER'S SUGGESTED CONTENT:
\`\`\`${ext}
${params.content}
\`\`\`

INSTRUCTIONS:
- Write the COMPLETE file content.
- Fix any bugs, type errors, missing imports, or issues in the planner's suggestion.
- Maintain consistent style and conventions for ${ext} files.
- Do NOT add explanations or markdown formatting.
- Output ONLY the file content, nothing else.

FILE CONTENT:`
  }

  /**
   * Self-check pass: ask the coder to verify its own output.
   * Returns the original code if the check passes, or a corrected version.
   */
  async function selfCheck(
    coderModel: Provider.Model,
    input: {
      filePath: string
      fileContent: string
      oldString: string
      newString: string
      context: string
    },
  ): Promise<string> {
    const ext = path.extname(input.filePath).slice(1) || "txt"
    const prompt = `You are a code review engine. Check this code for correctness.

FILE: \`${input.filePath}\`
TASK CONTEXT: ${input.context.slice(0, 500)}

${input.oldString ? `ORIGINAL CODE BEING REPLACED:\n\`\`\`${ext}\n${input.oldString}\n\`\`\`\n` : ""}CODE TO VERIFY:
\`\`\`${ext}
${input.newString}
\`\`\`

${input.fileContent ? `SURROUNDING FILE CONTEXT:\n\`\`\`${ext}\n${input.fileContent.slice(0, 3000)}\n\`\`\`\n` : ""}
CHECK FOR:
- Syntax errors
- Missing imports or undefined references
- Type mismatches
- Logic errors
- Incorrect indentation

If the code is correct, output it EXACTLY as-is.
If there are issues, output the CORRECTED version only.
No explanations. Code only.

VERIFIED CODE:`

    const result = await callCoder(coderModel, prompt)
    if (!result) {
      log.info("self-check returned empty, keeping original")
      return input.newString
    }

    const verified = extractCode(result, input.newString)

    // If the self-check changed the code, log it
    if (verified !== input.newString) {
      log.info("self-check made corrections", {
        file: input.filePath,
        originalLen: input.newString.length,
        correctedLen: verified.length,
      })
    }

    return verified
  }

  /**
   * Call the coder model with a simple text generation request.
   * No tools, no streaming — just prompt in, text out.
   */
  async function callCoder(model: Provider.Model, prompt: string): Promise<string | undefined> {
    try {
      const language = await Provider.getLanguage(model)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)

      const result = await generateText({
        model: language,
        prompt,
        maxOutputTokens: MAX_CODE_TOKENS,
        temperature: 0.1, // Low temperature for deterministic code
        abortSignal: controller.signal,
      })

      clearTimeout(timeout)

      const text = result.text?.trim()
      if (!text) return undefined

      log.info("coder model responded", {
        model: model.id,
        inputLen: prompt.length,
        outputLen: text.length,
        tokens: {
          input: result.usage?.inputTokens,
          output: result.usage?.outputTokens,
        },
      })

      return text
    } catch (err) {
      log.error("coder model call failed", {
        model: model.id,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /**
   * Extract code from the coder model's response.
   *
   * The coder should return raw code, but sometimes wraps it in
   * markdown code fences. This strips those if present.
   *
   * @param response - Raw response from the coder model.
   * @param fallback - Fallback code if extraction fails.
   * @returns Clean code string.
   */
  function extractCode(response: string, fallback: string): string {
    let code = response.trim()

    // Strip markdown code fences if present
    const fenceMatch = code.match(/^```[\w]*\n([\s\S]*?)\n```$/m)
    if (fenceMatch) {
      code = fenceMatch[1]
    }

    // If the response is just whitespace or very short, use fallback
    if (code.length < 2) return fallback

    return code
  }

  /**
   * Build a context string from recent conversation for the coder.
   *
   * Extracts the planner's recent reasoning without dumping the
   * full conversation. Keeps it focused on the current task.
   *
   * @param messages - Recent message history.
   * @param maxLen - Maximum context length in characters.
   * @returns Condensed context string.
   */
  export function buildContext(
    messages: Array<{ role: string; content?: string; parts?: Array<{ type: string; text?: string }> }>,
    maxLen: number = 2000,
  ): string {
    const parts: string[] = []
    let len = 0

    // Walk backwards through messages to get recent context
    for (let i = messages.length - 1; i >= 0 && len < maxLen; i--) {
      const msg = messages[i]
      if (msg.role === "user" && msg.content) {
        const text = `User: ${msg.content.slice(0, 500)}`
        parts.unshift(text)
        len += text.length
      } else if (msg.role === "assistant") {
        // Extract text parts from assistant messages
        if (msg.parts) {
          for (const part of msg.parts) {
            if (part.type === "text" && part.text) {
              const text = `Assistant: ${part.text.slice(0, 500)}`
              parts.unshift(text)
              len += text.length
              break // Only take the first text part
            }
          }
        } else if (msg.content) {
          const text = `Assistant: ${msg.content.slice(0, 500)}`
          parts.unshift(text)
          len += text.length
        }
      }
    }

    return parts.join("\n\n") || "No additional context."
  }
}
