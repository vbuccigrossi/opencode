import { Log } from "@/util/log"

/**
 * Ollama local model provider auto-detection.
 *
 * Queries the ollama REST API to discover available models and
 * registers them as an opencode provider. This enables seamless
 * local model usage without manual configuration.
 */
export namespace Ollama {
  const log = Log.create({ service: "provider.ollama" })

  /** Default ollama API base URL. */
  const DEFAULT_BASE_URL = "http://localhost:11434"

  /** Model info returned by ollama /api/tags endpoint. */
  interface OllamaModel {
    name: string
    modified_at: string
    size: number
    details: {
      parameter_size?: string
      quantization_level?: string
      family?: string
    }
  }

  /** Response from ollama /api/tags. */
  interface TagsResponse {
    models: OllamaModel[]
  }

  /**
   * Check if ollama is running and reachable.
   *
   * @param baseURL - Ollama API base URL (default: http://localhost:11434)
   * @returns true if ollama responds
   */
  export async function isRunning(baseURL?: string): Promise<boolean> {
    const url = baseURL ?? DEFAULT_BASE_URL
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`${url}/api/tags`, { signal: controller.signal })
      clearTimeout(timeout)
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * List models available in the local ollama instance.
   *
   * @param baseURL - Ollama API base URL
   * @returns Array of model names, or empty if ollama is not running
   */
  export async function listModels(baseURL?: string): Promise<string[]> {
    const url = baseURL ?? DEFAULT_BASE_URL
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${url}/api/tags`, { signal: controller.signal })
      clearTimeout(timeout)
      if (!res.ok) return []
      const data = (await res.json()) as TagsResponse
      return data.models.map((m) => m.name)
    } catch {
      return []
    }
  }

  /**
   * Get detailed model info from ollama.
   *
   * @param baseURL - Ollama API base URL
   * @returns Array of model info objects
   */
  export async function getModels(baseURL?: string): Promise<OllamaModel[]> {
    const url = baseURL ?? DEFAULT_BASE_URL
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${url}/api/tags`, { signal: controller.signal })
      clearTimeout(timeout)
      if (!res.ok) return []
      const data = (await res.json()) as TagsResponse
      return data.models
    } catch {
      return []
    }
  }

  /**
   * Parse parameter size string (e.g. "3.1B", "14B", "137M") to billions.
   *
   * @param size - Parameter size string from ollama model details
   * @returns Size in billions (e.g. 3.1, 14, 0.137)
   */
  function parseParamSize(size?: string): number {
    if (!size) return 0
    const match = size.match(/^([\d.]+)\s*([BMK])/i)
    if (!match) return 0
    const value = parseFloat(match[1])
    const unit = match[2].toUpperCase()
    if (unit === "B") return value
    if (unit === "M") return value / 1000
    if (unit === "K") return value / 1_000_000
    return 0
  }

  /**
   * Build an opencode provider config entry for ollama.
   *
   * Creates a provider config that can be merged into the provider
   * system, with all locally available models registered.
   *
   * @param baseURL - Ollama API base URL
   * @returns Provider config object, or undefined if ollama isn't running
   */
  export async function buildProviderConfig(baseURL?: string): Promise<
    | {
        name: string
        api: string
        npm: string
        models: Record<
          string,
          {
            name: string
            id: string
            attachment: boolean
            reasoning: boolean
            temperature: boolean
            tool_call: boolean
          }
        >
      }
    | undefined
  > {
    const url = baseURL ?? DEFAULT_BASE_URL
    const models = await getModels(url)
    if (models.length === 0) return undefined

    const modelEntries: Record<string, any> = {}
    for (const model of models) {
      const name = model.name
      // Skip embedding-only models
      if (name.includes("embed") || name.includes("nomic")) continue

      // Only enable tool calling for models large enough to handle it reliably.
      // Models under 7B tend to hallucinate tool call JSON instead of responding naturally.
      const paramSize = parseParamSize(model.details.parameter_size)
      const supportsTools = paramSize >= 7

      modelEntries[name] = {
        name,
        id: name,
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: supportsTools,
        param_size: paramSize,
      }
    }

    if (Object.keys(modelEntries).length === 0) return undefined

    log.info("ollama provider auto-detected", {
      baseURL: url,
      models: Object.keys(modelEntries).length,
    })

    return {
      name: "Ollama (Local)",
      api: `${url}/v1`,
      npm: "@ai-sdk/openai-compatible",
      models: modelEntries,
    }
  }
}
