import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Ollama } from "@/provider/ollama"

/**
 * Embedding provider — generates vector embeddings via any OpenAI-compatible API.
 *
 * Supports ollama, OpenAI, or any endpoint that implements the /v1/embeddings spec.
 * Handles batching, retries, and caching of the embedding model configuration.
 */
export namespace EmbeddingProvider {
  const log = Log.create({ service: "embedding.provider" })

  /** Configuration for the embedding provider. */
  export interface ProviderConfig {
    /** Base URL for the embedding API (e.g. "http://localhost:11434/v1") */
    baseURL: string
    /** Model name for embeddings (e.g. "nomic-embed-text", "all-minilm") */
    model: string
    /** Optional API key for authenticated endpoints */
    apiKey?: string
    /** Embedding dimension (auto-detected on first call if not specified) */
    dimensions?: number
    /** Maximum batch size for embedding requests (default: 32) */
    batchSize?: number
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number
  }

  /** Default configuration (ollama on localhost). */
  const DEFAULTS: ProviderConfig = {
    baseURL: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    batchSize: 32,
    timeout: 30_000,
  }

  /** Detected embedding dimension (cached after first successful call). */
  let detectedDimension: number | undefined

  /** Cached auto-detected embedding model name from ollama. */
  let autoDetectedModel: string | undefined

  /** Known embedding model name patterns. */
  const EMBEDDING_MODEL_PATTERNS = [
    "nomic-embed",
    "all-minilm",
    "mxbai-embed",
    "snowflake-arctic-embed",
    "bge-",
    "embed",
  ]

  /**
   * Auto-detect an available embedding model from ollama.
   *
   * Queries ollama's model list and returns the first model whose name
   * matches known embedding model patterns. Results are cached.
   *
   * @param baseURL - Ollama base URL (without /v1 suffix)
   * @returns Model name if found, undefined otherwise
   */
  async function autoDetectEmbeddingModel(baseURL?: string): Promise<string | undefined> {
    if (autoDetectedModel) return autoDetectedModel

    // Strip /v1 suffix to get the ollama base URL
    const ollamaBase = (baseURL ?? "http://localhost:11434/v1").replace(/\/v1\/?$/, "")

    try {
      const models = await Ollama.listModels(ollamaBase)
      for (const pattern of EMBEDDING_MODEL_PATTERNS) {
        const match = models.find((m) => m.toLowerCase().includes(pattern))
        if (match) {
          autoDetectedModel = match
          log.info("auto-detected embedding model", { model: match })
          return match
        }
      }
    } catch {
      // ollama not running — fall through
    }
    return undefined
  }

  /**
   * Get the effective embedding configuration.
   *
   * Merges defaults with user config from opencode.jsonc. If no model
   * is explicitly configured, auto-detects an embedding model from ollama.
   *
   * @returns Resolved embedding provider config
   */
  export async function getConfig(): Promise<ProviderConfig> {
    let userConfig: Partial<ProviderConfig> = {}
    try {
      const config = await Config.get()
      const embeddingConfig = (config as any).embedding as Partial<ProviderConfig> | undefined
      if (embeddingConfig) {
        userConfig = embeddingConfig
      }
    } catch {
      // No Instance context — use defaults
    }

    const merged = { ...DEFAULTS, ...userConfig }

    // If user didn't specify a model, try to auto-detect from ollama
    if (!userConfig.model) {
      const detected = await autoDetectEmbeddingModel(merged.baseURL)
      if (detected) {
        merged.model = detected
      }
    }

    return merged
  }

  /**
   * Generate embeddings for one or more text inputs.
   *
   * Calls the /v1/embeddings endpoint in batches if needed.
   * Returns Float32Array vectors for efficient storage and computation.
   *
   * @param texts - Array of text strings to embed
   * @param config - Optional config override
   * @returns Array of Float32Array embeddings (one per input text)
   * @throws Error if the embedding API is unavailable or returns an error
   */
  export async function embed(texts: string[], config?: Partial<ProviderConfig>): Promise<Float32Array[]> {
    const cfg = { ...DEFAULTS, ...config }
    if (texts.length === 0) return []

    const batchSize = cfg.batchSize ?? 32
    const results: Float32Array[] = []

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const batchResults = await callEmbeddingAPI(batch, cfg)
      results.push(...batchResults)
    }

    return results
  }

  /**
   * Generate a single embedding for a text string.
   *
   * Convenience wrapper around embed() for single inputs.
   *
   * @param text - Text to embed
   * @param config - Optional config override
   * @returns Float32Array embedding vector
   */
  export async function embedOne(text: string, config?: Partial<ProviderConfig>): Promise<Float32Array> {
    const results = await embed([text], config)
    return results[0]
  }

  /**
   * Get the embedding dimension (auto-detected or configured).
   *
   * @param config - Optional config override
   * @returns Dimension count
   */
  export async function getDimension(config?: Partial<ProviderConfig>): Promise<number> {
    if (detectedDimension) return detectedDimension
    const cfg = { ...DEFAULTS, ...config }
    if (cfg.dimensions) {
      detectedDimension = cfg.dimensions
      return cfg.dimensions
    }

    // Auto-detect by embedding a short probe string
    const probe = await embedOne("dimension probe", config)
    detectedDimension = probe.length
    log.info("auto-detected embedding dimension", { dimension: detectedDimension, model: cfg.model })
    return detectedDimension
  }

  /**
   * Check if the embedding provider is reachable.
   *
   * @param config - Optional config override
   * @returns true if the API responds to a test embedding
   */
  export async function isAvailable(config?: Partial<ProviderConfig>): Promise<boolean> {
    try {
      await embedOne("test", config)
      return true
    } catch {
      return false
    }
  }

  /**
   * Reset the cached dimension (for testing or model switch).
   */
  export function resetCache(): void {
    detectedDimension = undefined
    autoDetectedModel = undefined
  }

  /**
   * Call the OpenAI-compatible /v1/embeddings API.
   *
   * @param inputs - Array of text strings
   * @param cfg - Provider configuration
   * @returns Array of Float32Array embeddings
   */
  async function callEmbeddingAPI(inputs: string[], cfg: ProviderConfig): Promise<Float32Array[]> {
    const url = `${cfg.baseURL.replace(/\/+$/, "")}/embeddings`

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (cfg.apiKey) {
      headers["Authorization"] = `Bearer ${cfg.apiKey}`
    }

    const body: Record<string, unknown> = {
      model: cfg.model,
      input: inputs,
    }
    if (cfg.dimensions) {
      body.dimensions = cfg.dimensions
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), cfg.timeout ?? 30_000)

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error")
        throw new Error(`Embedding API error ${response.status}: ${errorText}`)
      }

      const json = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>
        model: string
        usage?: { prompt_tokens: number; total_tokens: number }
      }

      if (!json.data || !Array.isArray(json.data)) {
        throw new Error("Invalid embedding API response: missing data array")
      }

      // Sort by index to maintain input order
      const sorted = json.data.sort((a, b) => a.index - b.index)

      const embeddings = sorted.map((item) => {
        const vec = new Float32Array(item.embedding)
        // Cache dimension on first result
        if (!detectedDimension) {
          detectedDimension = vec.length
        }
        return vec
      })

      log.info("embedding batch complete", {
        inputs: inputs.length,
        dimension: embeddings[0]?.length,
        model: json.model,
        tokens: json.usage?.total_tokens,
      })

      return embeddings
    } finally {
      clearTimeout(timeout)
    }
  }
}
