import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs"
import path from "path"
import os from "os"
import { Crawler } from "../../src/embedding/crawler"
import { Chunker } from "../../src/embedding/chunker"
import { RAG } from "../../src/embedding/rag"
import { EmbeddingStore } from "../../src/embedding/store"

/**
 * Tests for RAG subsystems: Crawler, Chunker, RAG orchestrator,
 * sqlite-vec integration, and vector store operations.
 *
 * Uses a temporary directory with sample files to exercise the full pipeline
 * without needing an actual embedding provider.
 */

let testDir: string

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `rag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true })
  }
})

/**
 * Create a file in the test directory with the given content.
 *
 * @param relativePath - Path relative to testDir
 * @param content - File content
 */
function createFile(relativePath: string, content: string): void {
  const fullPath = path.join(testDir, relativePath)
  const dir = path.dirname(fullPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(fullPath, content)
}

// ---------------------------------------------------------------------------
// Crawler tests
// ---------------------------------------------------------------------------

describe("Crawler", () => {
  it("crawls a directory and finds files by extension", () => {
    createFile("src/main.ts", 'console.log("hello")')
    createFile("src/utils.ts", "export function add(a: number, b: number) { return a + b }")
    createFile("src/styles.css", "body { margin: 0 }")
    createFile("README.md", "# Test Project")

    const files = Crawler.crawl({
      sources: [testDir],
      exclude: Crawler.DEFAULT_EXCLUDES,
      extensions: [".ts", ".md"],
    })

    const names = files.map((f) => f.relativePath).sort()
    expect(names).toContain("src/main.ts")
    expect(names).toContain("src/utils.ts")
    expect(names).toContain("README.md")
    expect(names).not.toContain("src/styles.css")
  })

  it("excludes directories in the exclude list", () => {
    createFile("src/app.ts", "const x = 1")
    createFile("node_modules/lib/index.ts", "const y = 2")
    createFile(".git/config", "bare = false")

    const files = Crawler.crawl({
      sources: [testDir],
      exclude: ["node_modules", ".git"],
      extensions: [".ts"],
    })

    expect(files.length).toBe(1)
    expect(files[0].relativePath).toBe("src/app.ts")
  })

  it("skips empty files", () => {
    createFile("empty.ts", "")
    createFile("notempty.ts", "const x = 1")

    const files = Crawler.crawl({
      sources: [testDir],
      exclude: [],
      extensions: [".ts"],
    })

    expect(files.length).toBe(1)
    expect(files[0].relativePath).toBe("notempty.ts")
  })

  it("handles non-existent source directories gracefully", () => {
    const files = Crawler.crawl({
      sources: ["/tmp/nonexistent-dir-12345"],
      exclude: [],
      extensions: [".ts"],
    })

    expect(files.length).toBe(0)
  })

  it("resolves ~ paths", () => {
    const resolved = Crawler.resolvePath("~/some/path")
    const home = process.env.HOME || process.env.USERPROFILE || ""
    expect(resolved).toBe(path.join(home, "some/path"))
  })

  it("classifies file types correctly", () => {
    expect(Crawler.fileType(".ts")).toBe("code")
    expect(Crawler.fileType(".py")).toBe("code")
    expect(Crawler.fileType(".md")).toBe("doc")
    expect(Crawler.fileType(".json")).toBe("config")
    expect(Crawler.fileType(".yaml")).toBe("config")
  })

  it("crawls multiple source directories", () => {
    const srcDir = path.join(testDir, "src")
    const docsDir = path.join(testDir, "docs")
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(docsDir, { recursive: true })

    createFile("src/main.ts", "const x = 1")
    createFile("docs/guide.md", "# Guide")

    const files = Crawler.crawl({
      sources: [srcDir, docsDir],
      exclude: [],
      extensions: [".ts", ".md"],
    })

    expect(files.length).toBe(2)
  })

  it("tracks file metadata (size, mtime, extension)", () => {
    createFile("app.ts", "const x = 42")

    const files = Crawler.crawl({
      sources: [testDir],
      exclude: [],
      extensions: [".ts"],
    })

    expect(files.length).toBe(1)
    expect(files[0].extension).toBe(".ts")
    expect(files[0].size).toBeGreaterThan(0)
    expect(files[0].mtimeMs).toBeGreaterThan(0)
    expect(files[0].sourceRoot).toBe(testDir)
  })

  it("crawlChanged filters by mtime", () => {
    createFile("old.ts", "const old = 1")
    const beforeTime = Date.now()

    // Sleep briefly to ensure mtime difference
    const start = Date.now()
    while (Date.now() - start < 50) {} // busy wait

    createFile("new.ts", "const newFile = 2")

    const changed = Crawler.crawlChanged(
      {
        sources: [testDir],
        exclude: [],
        extensions: [".ts"],
      },
      beforeTime,
    )

    expect(changed.length).toBe(1)
    expect(changed[0].relativePath).toBe("new.ts")
  })

  it("respects max depth for deeply nested directories", () => {
    // Create a deeply nested structure (not 20+ deep, just verify recursion works)
    let nested = "a"
    for (let i = 0; i < 5; i++) nested = path.join(nested, "b")
    createFile(path.join(nested, "deep.ts"), "const deep = true")

    const files = Crawler.crawl({
      sources: [testDir],
      exclude: [],
      extensions: [".ts"],
    })

    expect(files.length).toBe(1)
    expect(files[0].relativePath).toContain("deep.ts")
  })

  it("handles symlinks and special files without crashing", () => {
    createFile("normal.ts", "const x = 1")
    // Just verify it doesn't crash on the directory
    const files = Crawler.crawl({
      sources: [testDir],
      exclude: [],
      extensions: [".ts"],
    })
    expect(files.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Chunker tests
// ---------------------------------------------------------------------------

describe("Chunker", () => {
  it("chunks a TypeScript file into segments", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `function fn${i}() { return ${i} }`).join("\n")
    createFile("big.ts", content)

    const entry: Crawler.FileEntry = {
      absolutePath: path.join(testDir, "big.ts"),
      relativePath: "big.ts",
      sourceRoot: testDir,
      extension: ".ts",
      size: content.length,
      mtimeMs: Date.now(),
    }

    const chunks = await Chunker.chunkFile(entry, { chunkSize: 200, chunkOverlap: 20 })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.filePath).toBe(entry.absolutePath)
      expect(chunk.type).toBe("code")
      expect(chunk.startLine).toBeGreaterThanOrEqual(1)
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
      expect(chunk.chunkID).toMatch(/^.+:\d+-\d+$/)
    }
  })

  it("returns empty array for empty files", async () => {
    createFile("empty.ts", "")

    const entry: Crawler.FileEntry = {
      absolutePath: path.join(testDir, "empty.ts"),
      relativePath: "empty.ts",
      sourceRoot: testDir,
      extension: ".ts",
      size: 0,
      mtimeMs: Date.now(),
    }

    const chunks = await Chunker.chunkFile(entry)
    expect(chunks.length).toBe(0)
  })

  it("handles markdown files with doc type", async () => {
    const content = "# Title\n\nSome paragraph.\n\n## Section\n\nMore content here."
    createFile("readme.md", content)

    const entry: Crawler.FileEntry = {
      absolutePath: path.join(testDir, "readme.md"),
      relativePath: "readme.md",
      sourceRoot: testDir,
      extension: ".md",
      size: content.length,
      mtimeMs: Date.now(),
    }

    const chunks = await Chunker.chunkFile(entry)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks[0].type).toBe("doc")
  })

  it("formats chunks for embedding with metadata", () => {
    const chunk: Chunker.Chunk = {
      content: "function hello() { return 'world' }",
      filePath: "/tmp/test/src/hello.ts",
      relativePath: "src/hello.ts",
      sourceRoot: "/tmp/test",
      startLine: 1,
      endLine: 1,
      type: "code",
      extension: ".ts",
      chunkID: "/tmp/test/src/hello.ts:1-1",
    }

    const formatted = Chunker.formatForEmbedding(chunk)
    expect(formatted).toContain("File: src/hello.ts")
    expect(formatted).toContain("Type: code")
    expect(formatted).toContain("Lines: 1-1")
    expect(formatted).toContain("function hello()")
  })

  it("chunks multiple files in sequence", async () => {
    createFile("a.ts", "const a = 1\nconst b = 2\nconst c = 3")
    createFile("b.ts", "const d = 4\nconst e = 5")

    const entries: Crawler.FileEntry[] = [
      {
        absolutePath: path.join(testDir, "a.ts"),
        relativePath: "a.ts",
        sourceRoot: testDir,
        extension: ".ts",
        size: 30,
        mtimeMs: Date.now(),
      },
      {
        absolutePath: path.join(testDir, "b.ts"),
        relativePath: "b.ts",
        sourceRoot: testDir,
        extension: ".ts",
        size: 20,
        mtimeMs: Date.now(),
      },
    ]

    const chunks = await Chunker.chunkFiles(entries)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  it("handles non-existent file gracefully", async () => {
    const entry: Crawler.FileEntry = {
      absolutePath: path.join(testDir, "nonexistent.ts"),
      relativePath: "nonexistent.ts",
      sourceRoot: testDir,
      extension: ".ts",
      size: 100,
      mtimeMs: Date.now(),
    }

    const chunks = await Chunker.chunkFile(entry)
    expect(chunks.length).toBe(0)
  })

  it("handles Python files with language-aware splitting", async () => {
    const content = [
      "def hello():",
      '    """Say hello."""',
      '    return "hello"',
      "",
      "def world():",
      '    """Say world."""',
      '    return "world"',
      "",
      "class Greeter:",
      '    """A greeter class."""',
      "    def greet(self, name):",
      '        return f"Hello, {name}"',
    ].join("\n")
    createFile("main.py", content)

    const entry: Crawler.FileEntry = {
      absolutePath: path.join(testDir, "main.py"),
      relativePath: "main.py",
      sourceRoot: testDir,
      extension: ".py",
      size: content.length,
      mtimeMs: Date.now(),
    }

    const chunks = await Chunker.chunkFile(entry, { chunkSize: 100, chunkOverlap: 10 })
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks[0].type).toBe("code")
    expect(chunks[0].extension).toBe(".py")
  })

  it("handles JSON config files", async () => {
    const content = JSON.stringify({ name: "test", version: "1.0", scripts: { test: "bun test" } }, null, 2)
    createFile("package.json", content)

    const entry: Crawler.FileEntry = {
      absolutePath: path.join(testDir, "package.json"),
      relativePath: "package.json",
      sourceRoot: testDir,
      extension: ".json",
      size: content.length,
      mtimeMs: Date.now(),
    }

    const chunks = await Chunker.chunkFile(entry)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks[0].type).toBe("config")
  })

  it("chunk IDs contain file path and line range", async () => {
    createFile("simple.ts", "const x = 1\nconst y = 2\nconst z = 3")

    const entry: Crawler.FileEntry = {
      absolutePath: path.join(testDir, "simple.ts"),
      relativePath: "simple.ts",
      sourceRoot: testDir,
      extension: ".ts",
      size: 30,
      mtimeMs: Date.now(),
    }

    const chunks = await Chunker.chunkFile(entry)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    // chunkID format: absolutePath:startLine-endLine
    for (const chunk of chunks) {
      expect(chunk.chunkID).toContain(path.join(testDir, "simple.ts"))
      expect(chunk.chunkID).toMatch(/:\d+-\d+$/)
    }
  })
})

// ---------------------------------------------------------------------------
// EmbeddingStore tests (sqlite-vec and vector operations)
// ---------------------------------------------------------------------------

describe("EmbeddingStore", () => {
  it("serializes and deserializes Float32Array round-trip", () => {
    const original = new Float32Array([0.1, 0.2, 0.3, -0.5, 1.0])
    const buf = EmbeddingStore.serialize(original)
    const restored = EmbeddingStore.deserialize(buf)

    expect(restored.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5)
    }
  })

  it("computes cosine similarity correctly for identical vectors", () => {
    const vec = new Float32Array([1, 0, 0, 0])
    const sim = EmbeddingStore.cosineSimilarity(vec, vec)
    expect(sim).toBeCloseTo(1.0, 5)
  })

  it("computes cosine similarity correctly for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0, 0])
    const b = new Float32Array([0, 1, 0, 0])
    const sim = EmbeddingStore.cosineSimilarity(a, b)
    expect(sim).toBeCloseTo(0.0, 5)
  })

  it("computes cosine similarity correctly for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0, 0])
    const b = new Float32Array([-1, 0, 0, 0])
    const sim = EmbeddingStore.cosineSimilarity(a, b)
    expect(sim).toBeCloseTo(-1.0, 5)
  })

  it("computes cosine similarity for arbitrary vectors", () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([4, 5, 6])
    // Expected: (1*4 + 2*5 + 3*6) / (sqrt(14) * sqrt(77)) = 32 / sqrt(1078)
    const expected = 32 / Math.sqrt(14 * 77)
    const sim = EmbeddingStore.cosineSimilarity(a, b)
    expect(sim).toBeCloseTo(expected, 5)
  })

  it("throws on dimension mismatch", () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([1, 2])
    expect(() => EmbeddingStore.cosineSimilarity(a, b)).toThrow("Vector dimension mismatch")
  })

  it("handles zero vectors", () => {
    const a = new Float32Array([0, 0, 0])
    const b = new Float32Array([1, 2, 3])
    const sim = EmbeddingStore.cosineSimilarity(a, b)
    expect(sim).toBe(0)
  })

  it("detects sqlite-vec availability", () => {
    // Should return a boolean without throwing
    const available = EmbeddingStore.isSqliteVecAvailable()
    expect(typeof available).toBe("boolean")
  })

  it("serializes large vectors efficiently", () => {
    const size = 768 // common embedding dimension
    const original = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      original[i] = Math.random() * 2 - 1
    }

    const buf = EmbeddingStore.serialize(original)
    expect(buf.byteLength).toBe(size * 4) // Float32 = 4 bytes

    const restored = EmbeddingStore.deserialize(buf)
    expect(restored.length).toBe(size)
    for (let i = 0; i < size; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5)
    }
  })
})

// ---------------------------------------------------------------------------
// RAG config tests
// ---------------------------------------------------------------------------

describe("RAG", () => {
  it("getConfig returns defaults when no config context", async () => {
    const config = await RAG.getConfig()
    expect(config.sources).toEqual([])
    expect(config.chunkSize).toBe(1000)
    expect(config.chunkOverlap).toBe(100)
    expect(config.exclude.length).toBeGreaterThan(0)
    expect(config.extensions.length).toBeGreaterThan(0)
  })

  it("isConfigured returns false with no sources", async () => {
    const configured = await RAG.isConfigured()
    expect(configured).toBe(false)
  })

  it("stats returns empty when no manifest exists", () => {
    const s = RAG.stats()
    expect(s.totalFiles).toBe(0)
    expect(s.totalChunks).toBe(0)
  })

  it("index returns early with no sources configured", async () => {
    const result = await RAG.index({ sources: [] })
    expect(result.totalFiles).toBe(0)
    expect(result.changedFiles).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("default config includes standard excludes", async () => {
    const config = await RAG.getConfig()
    expect(config.exclude).toContain("node_modules")
    expect(config.exclude).toContain(".git")
    expect(config.exclude).toContain("dist")
  })

  it("default config includes common file extensions", async () => {
    const config = await RAG.getConfig()
    expect(config.extensions).toContain(".ts")
    expect(config.extensions).toContain(".py")
    expect(config.extensions).toContain(".md")
    expect(config.extensions).toContain(".json")
  })
})

// ---------------------------------------------------------------------------
// Integration: Crawler → Chunker pipeline
// ---------------------------------------------------------------------------

describe("Crawler → Chunker integration", () => {
  it("crawls and chunks a multi-file project", async () => {
    createFile("src/api.ts", [
      "export function getUser(id: string) {",
      "  return db.query('SELECT * FROM users WHERE id = ?', [id])",
      "}",
      "",
      "export function createUser(name: string, email: string) {",
      "  return db.query('INSERT INTO users (name, email) VALUES (?, ?)', [name, email])",
      "}",
    ].join("\n"))

    createFile("src/utils.ts", [
      "export function formatDate(date: Date): string {",
      "  return date.toISOString()",
      "}",
      "",
      "export function slugify(text: string): string {",
      "  return text.toLowerCase().replace(/\\s+/g, '-')",
      "}",
    ].join("\n"))

    createFile("docs/README.md", [
      "# My Project",
      "",
      "This is a sample project for testing RAG indexing.",
      "",
      "## API",
      "",
      "The API module provides user management functions.",
    ].join("\n"))

    const files = Crawler.crawl({
      sources: [testDir],
      exclude: Crawler.DEFAULT_EXCLUDES,
      extensions: [".ts", ".md"],
    })

    expect(files.length).toBe(3)

    const allChunks = await Chunker.chunkFiles(files, { chunkSize: 200, chunkOverlap: 20 })
    expect(allChunks.length).toBeGreaterThanOrEqual(3)

    // Verify each chunk has proper metadata
    for (const chunk of allChunks) {
      expect(chunk.filePath).toBeTruthy()
      expect(chunk.relativePath).toBeTruthy()
      expect(chunk.content.length).toBeGreaterThan(0)
      expect(chunk.chunkID).toBeTruthy()
    }

    // Verify formatting for embedding
    for (const chunk of allChunks) {
      const formatted = Chunker.formatForEmbedding(chunk)
      expect(formatted).toContain("File:")
      expect(formatted).toContain("Type:")
      expect(formatted).toContain("Lines:")
    }
  })

  it("respects extension filtering in the full pipeline", async () => {
    createFile("code.ts", "const x = 1")
    createFile("styles.css", "body { margin: 0 }")
    createFile("data.csv", "a,b,c")
    createFile("readme.md", "# Hello")

    const files = Crawler.crawl({
      sources: [testDir],
      exclude: [],
      extensions: [".ts"],
    })

    expect(files.length).toBe(1)
    expect(files[0].extension).toBe(".ts")

    const chunks = await Chunker.chunkFiles(files)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.every((c) => c.extension === ".ts")).toBe(true)
  })
})
