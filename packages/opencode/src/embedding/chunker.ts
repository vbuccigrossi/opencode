import { readFileSync } from "fs"
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters"
import { Log } from "@/util/log"
import { Crawler } from "./crawler"

/**
 * Document chunker for RAG indexing.
 *
 * Splits files into semantically meaningful chunks for embedding.
 * Uses language-aware splitting for code files (via LangChain's
 * RecursiveCharacterTextSplitter.fromLanguage) and section-based
 * splitting for documentation/prose.
 */
export namespace Chunker {
  const log = Log.create({ service: "embedding.chunker" })

  /** A chunk of text from a file, ready for embedding. */
  export interface Chunk {
    /** The text content of this chunk. */
    content: string
    /** Absolute path of the source file. */
    filePath: string
    /** Relative path from the source root. */
    relativePath: string
    /** Source root directory. */
    sourceRoot: string
    /** Starting line number (1-based). */
    startLine: number
    /** Ending line number (1-based). */
    endLine: number
    /** Type of content. */
    type: "code" | "doc" | "config" | "security"
    /** File extension. */
    extension: string
    /** A unique identifier for this chunk (filePath:startLine-endLine). */
    chunkID: string
  }

  /** Chunking configuration. */
  export interface Config {
    /** Maximum chunk size in characters (default: 1000). */
    chunkSize: number
    /** Overlap between consecutive chunks in characters (default: 100). */
    chunkOverlap: number
  }

  const DEFAULT_CONFIG: Config = {
    chunkSize: 1000,
    chunkOverlap: 100,
  }

  /** Map file extensions to LangChain supported language names. */
  const EXT_TO_LANGUAGE: Record<string, string> = {
    ".ts": "js",
    ".tsx": "js",
    ".js": "js",
    ".jsx": "js",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "cpp",
    ".cpp": "cpp",
    ".h": "cpp",
    ".hpp": "cpp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".scala": "scala",
    ".kt": "java",
    ".lua": "latex", // fallback — no native Lua support
    ".md": "markdown",
    ".mdx": "markdown",
    ".html": "html",
    ".proto": "proto",
    ".rst": "rst",
    ".sol": "sol",
  }

  /**
   * Chunk a single file into embedding-ready segments.
   *
   * Uses language-aware splitting for code, markdown-aware splitting
   * for docs, and generic splitting for everything else.
   *
   * @param entry - File entry from the crawler
   * @param config - Chunking configuration
   * @returns Array of chunks from this file
   */
  export async function chunkFile(entry: Crawler.FileEntry, config?: Partial<Config>): Promise<Chunk[]> {
    const cfg = { ...DEFAULT_CONFIG, ...config }

    let content: string
    try {
      content = readFileSync(entry.absolutePath, "utf-8")
    } catch {
      log.warn("cannot read file for chunking", { path: entry.absolutePath })
      return []
    }

    if (content.trim().length === 0) return []

    const fileType = Crawler.fileType(entry.extension)
    const langKey = EXT_TO_LANGUAGE[entry.extension]

    let splitter: RecursiveCharacterTextSplitter
    if (langKey) {
      try {
        splitter = RecursiveCharacterTextSplitter.fromLanguage(langKey as any, {
          chunkSize: cfg.chunkSize,
          chunkOverlap: cfg.chunkOverlap,
        })
      } catch {
        // Unsupported language — fall back to generic
        splitter = new RecursiveCharacterTextSplitter({
          chunkSize: cfg.chunkSize,
          chunkOverlap: cfg.chunkOverlap,
        })
      }
    } else {
      splitter = new RecursiveCharacterTextSplitter({
        chunkSize: cfg.chunkSize,
        chunkOverlap: cfg.chunkOverlap,
      })
    }

    const texts = await splitter.splitText(content)

    // Map split texts back to line numbers
    const chunks: Chunk[] = []
    const lines = content.split("\n")
    let searchFrom = 0

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]
      const firstLine = text.split("\n")[0]

      // Find this chunk's location in the original file
      let startLine = searchFrom + 1
      for (let j = searchFrom; j < lines.length; j++) {
        if (lines[j].includes(firstLine.trim())) {
          startLine = j + 1
          searchFrom = j
          break
        }
      }

      const chunkLines = text.split("\n").length
      const endLine = startLine + chunkLines - 1

      chunks.push({
        content: text,
        filePath: entry.absolutePath,
        relativePath: entry.relativePath,
        sourceRoot: entry.sourceRoot,
        startLine,
        endLine: Math.min(endLine, lines.length),
        type: fileType,
        extension: entry.extension,
        chunkID: `${entry.absolutePath}:${startLine}-${endLine}`,
      })
    }

    return chunks
  }

  /**
   * Chunk multiple files in sequence.
   *
   * @param entries - File entries from the crawler
   * @param config - Chunking configuration
   * @returns Array of all chunks from all files
   */
  export async function chunkFiles(entries: Crawler.FileEntry[], config?: Partial<Config>): Promise<Chunk[]> {
    const allChunks: Chunk[] = []

    for (const entry of entries) {
      const chunks = await chunkFile(entry, config)
      allChunks.push(...chunks)
    }

    log.info("chunking complete", {
      files: entries.length,
      chunks: allChunks.length,
    })

    return allChunks
  }

  /**
   * Build a rich text representation of a chunk for embedding.
   *
   * Prepends file path and type metadata to help the embedding model
   * understand context.
   *
   * @param chunk - The chunk to format
   * @returns Text string ready for embedding
   */
  export function formatForEmbedding(chunk: Chunk): string {
    const parts: string[] = []
    parts.push(`File: ${chunk.relativePath}`)
    parts.push(`Type: ${chunk.type}`)
    parts.push(`Lines: ${chunk.startLine}-${chunk.endLine}`)
    parts.push("")
    parts.push(chunk.content)
    return parts.join("\n")
  }
}
