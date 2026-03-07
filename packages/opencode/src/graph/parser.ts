import { Language, type Parser as TSParser, type Tree as TSTree } from "web-tree-sitter"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"
import { fileURLToPath } from "url"
import { Global } from "@/global"
import path from "path"
import fs from "fs"

/**
 * Manages tree-sitter parser instances for multiple languages.
 *
 * Downloads language WASM files on demand and caches them in the
 * global data directory. Each language gets its own Parser instance
 * configured with the appropriate grammar.
 */
export namespace GraphParser {
  const log = Log.create({ service: "graph.parser" })

  /**
   * Maps file extensions to language identifiers.
   * TSX and JSX get their own grammars since they have distinct syntax.
   */
  const EXTENSION_MAP: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "tsx",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".rb": "ruby",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".php": "php",
  }

  /**
   * Maps language identifiers to the extractor language key.
   * TSX uses the same extraction logic as TypeScript.
   */
  const EXTRACTOR_LANGUAGE: Record<string, string> = {
    tsx: "typescript",
  }

  /** WASM download URLs for each language grammar. */
  const WASM_URLS: Record<string, string> = {
    typescript:
      "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-typescript.wasm",
    tsx: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
    javascript:
      "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-typescript.wasm",
    python: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm",
    go: "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
    rust: "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.0/tree-sitter-rust.wasm",
    java: "https://github.com/tree-sitter/tree-sitter-java/releases/download/v0.23.5/tree-sitter-java.wasm",
    ruby: "https://github.com/tree-sitter/tree-sitter-ruby/releases/download/v0.23.1/tree-sitter-ruby.wasm",
    c: "https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.24.1/tree-sitter-c.wasm",
    cpp: "https://github.com/tree-sitter/tree-sitter-cpp/releases/download/v0.23.4/tree-sitter-cpp.wasm",
    csharp:
      "https://github.com/tree-sitter/tree-sitter-c-sharp/releases/download/v0.23.1/tree-sitter-c_sharp.wasm",
    php: "https://github.com/tree-sitter/tree-sitter-php/releases/download/v0.24.2/tree-sitter-php.wasm",
  }

  /** Languages we support for code graph extraction. */
  export const SUPPORTED_LANGUAGES = Object.keys(WASM_URLS)

  const resolveWasm = (asset: string): string => {
    if (asset.startsWith("file://")) return fileURLToPath(asset)
    if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
    const url = new URL(asset, import.meta.url)
    return fileURLToPath(url)
  }

  /** Initialize the tree-sitter WASM runtime. Must be called before loading any language. */
  const initRuntime = lazy(async () => {
    const { Parser } = await import("web-tree-sitter")
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
      with: { type: "wasm" },
    })
    const treePath = resolveWasm(treeWasm)
    await Parser.init({
      locateFile() {
        return treePath
      },
    })
    return Parser
  })

  const languageCache = new Map<string, Language>()
  const parserCache = new Map<string, TSParser>()

  /**
   * Returns the directory where downloaded WASM files are cached.
   */
  function wasmCacheDir(): string {
    const dir = path.join(Global.Path.data, "graph", "wasm")
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * Downloads a WASM file if not already cached.
   *
   * @param language - The language identifier (e.g. "typescript")
   * @returns Absolute path to the cached WASM file
   */
  async function downloadWasm(language: string): Promise<string> {
    const url = WASM_URLS[language]
    if (!url) throw new Error(`No WASM URL configured for language: ${language}`)

    const filename = `tree-sitter-${language}.wasm`
    const cached = path.join(wasmCacheDir(), filename)

    if (fs.existsSync(cached)) return cached

    log.info("downloading language wasm", { language, url })
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download WASM for ${language}: ${response.status} ${response.statusText}`)
    }
    const buffer = await response.arrayBuffer()
    fs.writeFileSync(cached, Buffer.from(buffer))
    log.info("cached language wasm", { language, path: cached })
    return cached
  }

  /**
   * Loads a tree-sitter Language grammar, downloading WASM if needed.
   *
   * @param language - The language identifier
   * @returns The loaded Language instance
   */
  async function loadLanguage(language: string): Promise<Language> {
    const cached = languageCache.get(language)
    if (cached) return cached

    const wasmPath = await downloadWasm(language)
    const lang = await Language.load(wasmPath)
    languageCache.set(language, lang)
    return lang
  }

  /**
   * Gets or creates a Parser instance for the given language.
   *
   * @param language - The language identifier (e.g. "typescript", "python")
   * @returns A configured Parser ready to parse source code
   */
  export async function getParser(language: string): Promise<TSParser> {
    const cached = parserCache.get(language)
    if (cached) return cached

    const ParserClass = await initRuntime()
    const lang = await loadLanguage(language)
    const parser = new ParserClass()
    parser.setLanguage(lang)
    parserCache.set(language, parser)
    return parser
  }

  /**
   * Determines the language for a file based on its extension.
   *
   * @param filePath - Path to the source file
   * @returns Language identifier or undefined if unsupported
   */
  export function languageForFile(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase()
    return EXTENSION_MAP[ext]
  }

  /**
   * Checks if a file can be parsed by the graph system.
   *
   * @param filePath - Path to check
   * @returns true if the file's language is supported
   */
  export function isSupported(filePath: string): boolean {
    return languageForFile(filePath) !== undefined
  }

  /**
   * Returns the extractor language key for a parser language.
   * Some languages (tsx, jsx) share extraction logic with their base language.
   *
   * @param language - The parser language identifier
   * @returns The extractor language key
   */
  export function extractorLanguageFor(language: string): string {
    return EXTRACTOR_LANGUAGE[language] ?? language
  }

  /**
   * Parses source code and returns the tree-sitter syntax tree.
   *
   * @param filePath - Path to the file (used for language detection)
   * @param source - The source code to parse
   * @returns The parsed Tree, or undefined if the language is unsupported
   */
  export async function parse(filePath: string, source: string): Promise<TSTree | undefined> {
    const language = languageForFile(filePath)
    if (!language) return undefined

    const parser = await getParser(language)
    return parser.parse(source) ?? undefined
  }
}
