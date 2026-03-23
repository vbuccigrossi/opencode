import { readdirSync, statSync, existsSync } from "fs"
import path from "path"
import { Log } from "@/util/log"

/**
 * Directory crawler for RAG indexing.
 *
 * Recursively walks configured source directories, respects exclude patterns,
 * filters by file extension, and tracks file modification times for incremental
 * updates. Designed for efficiency on large directory trees.
 */
export namespace Crawler {
  const log = Log.create({ service: "embedding.crawler" })

  /** Default directories to exclude from crawling. */
  export const DEFAULT_EXCLUDES = [
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "venv",
    ".env",
    ".tox",
    "target",
    "vendor",
    ".cache",
    ".turbo",
    "coverage",
    ".nyc_output",
    ".idea",
    ".vscode",
    ".DS_Store",
  ]

  /** Default file extensions to index. */
  export const DEFAULT_EXTENSIONS = [
    // Code
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".rs",
    ".go",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".swift",
    ".kt",
    ".scala",
    ".lua",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    // Security / IDS
    ".rule",
    ".rules",
    ".yar",
    ".yara",
    ".sigma",
    // Docs
    ".md",
    ".mdx",
    ".txt",
    ".rst",
    ".adoc",
    // Config
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".env.example",
    // Web
    ".html",
    ".css",
    ".scss",
    ".less",
    ".svg",
    // Data
    ".sql",
    ".graphql",
    ".proto",
  ]

  /** Maximum file size to index (1MB). */
  const MAX_FILE_SIZE = 1_048_576

  /** Maximum directory depth to prevent infinite recursion. */
  const MAX_DEPTH = 20

  /** Crawler configuration. */
  export interface Config {
    /** Directories to crawl. */
    sources: string[]
    /** Directory names to exclude (default: DEFAULT_EXCLUDES). */
    exclude: string[]
    /** File extensions to include (default: DEFAULT_EXTENSIONS). */
    extensions: string[]
  }

  /** A discovered file with metadata. */
  export interface FileEntry {
    /** Absolute file path. */
    absolutePath: string
    /** Path relative to the source root that contains it. */
    relativePath: string
    /** Source root directory this file was found in. */
    sourceRoot: string
    /** File extension (lowercase, with dot). */
    extension: string
    /** File size in bytes. */
    size: number
    /** Last modification time (Unix ms). */
    mtimeMs: number
  }

  /**
   * Crawl configured source directories and return all matching files.
   *
   * @param config - Crawler configuration with sources, excludes, extensions
   * @returns Array of FileEntry objects for all matching files
   */
  export function crawl(config: Config): FileEntry[] {
    const results: FileEntry[] = []
    const excludeSet = new Set(config.exclude)
    const extSet = new Set(config.extensions.map((e) => e.toLowerCase()))

    for (const source of config.sources) {
      const resolved = resolvePath(source)
      if (!existsSync(resolved)) {
        log.warn("source directory not found, skipping", { source: resolved })
        continue
      }

      try {
        const stat = statSync(resolved)
        if (!stat.isDirectory()) {
          log.warn("source is not a directory, skipping", { source: resolved })
          continue
        }
      } catch {
        log.warn("cannot stat source directory, skipping", { source: resolved })
        continue
      }

      walkDirectory(resolved, resolved, excludeSet, extSet, results, 0)
    }

    log.info("crawl complete", {
      sources: config.sources.length,
      files: results.length,
    })

    return results
  }

  /**
   * Crawl and return only files that have changed since a given timestamp.
   *
   * @param config - Crawler configuration
   * @param since - Only return files modified after this Unix ms timestamp
   * @returns Array of FileEntry objects for changed files
   */
  export function crawlChanged(config: Config, since: number): FileEntry[] {
    const all = crawl(config)
    return all.filter((f) => f.mtimeMs > since)
  }

  /**
   * Resolve a path, expanding ~ to home directory.
   *
   * @param p - Path string, possibly starting with ~
   * @returns Resolved absolute path
   */
  export function resolvePath(p: string): string {
    if (p.startsWith("~/") || p === "~") {
      const home = process.env.HOME || process.env.USERPROFILE || ""
      return path.join(home, p.slice(2))
    }
    return path.resolve(p)
  }

  /**
   * Determine if a file is a code file vs documentation/config.
   *
   * @param ext - File extension (lowercase, with dot)
   * @returns "code", "doc", or "config"
   */
  export function fileType(ext: string): "code" | "doc" | "config" | "security" {
    const codeExts = new Set([
      ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
      ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift",
      ".kt", ".scala", ".lua", ".sh", ".bash", ".zsh", ".fish",
    ])
    const docExts = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".html"])
    const securityExts = new Set([".rule", ".rules", ".yar", ".yara", ".sigma"])

    if (securityExts.has(ext)) return "security"
    if (codeExts.has(ext)) return "code"
    if (docExts.has(ext)) return "doc"
    return "config"
  }

  /**
   * Recursively walk a directory, collecting matching files.
   *
   * @param dir - Current directory to walk
   * @param root - Original source root for relative path computation
   * @param excludes - Set of directory names to skip
   * @param extensions - Set of allowed file extensions
   * @param results - Array to push results into
   * @param depth - Current recursion depth
   */
  function walkDirectory(
    dir: string,
    root: string,
    excludes: Set<string>,
    extensions: Set<string>,
    results: FileEntry[],
    depth: number,
  ): void {
    if (depth > MAX_DEPTH) return

    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Permission denied or other FS error — skip
      return
    }

    for (const entry of entries) {
      const name = entry.name

      // Skip hidden files/dirs (except .env.example type patterns in extensions)
      if (name.startsWith(".") && excludes.has(name)) continue
      // Skip explicitly excluded directory names
      if (excludes.has(name)) continue

      const fullPath = path.join(dir, name)

      if (entry.isDirectory()) {
        walkDirectory(fullPath, root, excludes, extensions, results, depth + 1)
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase()
        if (!extensions.has(ext)) continue

        try {
          const stat = statSync(fullPath)
          if (stat.size > MAX_FILE_SIZE) continue
          if (stat.size === 0) continue

          results.push({
            absolutePath: fullPath,
            relativePath: path.relative(root, fullPath),
            sourceRoot: root,
            extension: ext,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          })
        } catch {
          // Cannot stat file — skip
        }
      }
    }
  }
}
