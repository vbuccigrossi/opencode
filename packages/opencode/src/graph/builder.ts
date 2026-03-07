import { Database, eq, and } from "@/storage/db"
import { GraphNodeTable, GraphEdgeTable, GraphFileStateTable } from "./schema.sql"
import { GraphParser } from "./parser"
import { Extractor } from "./extractor"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Ripgrep } from "../file/ripgrep"
import { ulid } from "ulid"
import fs from "fs"
import path from "path"
import crypto from "crypto"

/**
 * Builds and maintains the repository knowledge graph.
 *
 * Handles both full project indexing and incremental updates
 * for individual files. Parses source files with tree-sitter,
 * extracts entities and relationships, and persists them to SQLite.
 */
export namespace GraphBuilder {
  const log = Log.create({ service: "graph.builder" })

  /**
   * Computes a content hash for a source file.
   *
   * @param content - File content to hash
   * @returns hex-encoded SHA-256 hash
   */
  function contentHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)
  }

  /**
   * Indexes a single file, extracting nodes and edges into the graph DB.
   *
   * Skips files whose content hash hasn't changed since last index.
   *
   * @param filePath - Absolute path to the source file
   * @param projectID - Project identifier for scoping
   * @param force - If true, re-index even if hash matches
   * @returns Number of nodes extracted, or -1 if skipped
   */
  export async function indexFile(filePath: string, projectID: string, force = false): Promise<number> {
    const language = GraphParser.languageForFile(filePath)
    if (!language) return -1

    let source: string
    try {
      source = fs.readFileSync(filePath, "utf-8")
    } catch {
      // File may have been deleted — clean up any existing nodes
      await removeFile(filePath, projectID)
      return 0
    }

    const hash = contentHash(source)

    // Check if file has changed since last index
    if (!force) {
      const existing = Database.use((db) =>
        db
          .select()
          .from(GraphFileStateTable)
          .where(and(eq(GraphFileStateTable.project_id, projectID), eq(GraphFileStateTable.file_path, filePath)))
          .get(),
      )
      if (existing && existing.content_hash === hash) {
        return -1
      }
    }

    const tree = await GraphParser.parse(filePath, source)
    if (!tree) return 0

    const extractorLang = GraphParser.extractorLanguageFor(language)
    const result = Extractor.extract(tree, extractorLang, source)
    const relativePath = path.relative(Instance.worktree, filePath)

    // Remove old data for this file, then insert new
    Database.transaction((tx) => {
      // Delete old edges from this file
      tx.delete(GraphEdgeTable)
        .where(and(eq(GraphEdgeTable.project_id, projectID), eq(GraphEdgeTable.file_path, relativePath)))
        .run()

      tx.delete(GraphNodeTable)
        .where(and(eq(GraphNodeTable.project_id, projectID), eq(GraphNodeTable.file_path, relativePath)))
        .run()

      // Insert new nodes
      const nodeIdMap = new Map<string, string>()
      for (const raw of result.nodes) {
        const id = ulid()
        nodeIdMap.set(raw.name, id)
        tx.insert(GraphNodeTable)
          .values({
            id,
            project_id: projectID,
            file_path: relativePath,
            name: raw.name,
            kind: raw.kind,
            start_line: raw.startLine,
            end_line: raw.endLine,
            start_col: raw.startCol,
            end_col: raw.endCol,
            signature: raw.signature,
            content_hash: hash,
          })
          .run()
      }

      // Insert edges where both source and target nodes exist in this file
      // Cross-file edges are resolved during edge resolution pass
      for (const raw of result.edges) {
        const sourceID = nodeIdMap.get(raw.sourceNodeName)
        const targetID = nodeIdMap.get(raw.targetName)
        if (sourceID && targetID) {
          tx.insert(GraphEdgeTable)
            .values({
              id: ulid(),
              project_id: projectID,
              source_node_id: sourceID,
              target_node_id: targetID,
              kind: raw.kind,
              file_path: relativePath,
              line: raw.line,
            })
            .run()
        }
      }

      // Update file state
      tx.delete(GraphFileStateTable)
        .where(and(eq(GraphFileStateTable.project_id, projectID), eq(GraphFileStateTable.file_path, filePath)))
        .run()
      tx.insert(GraphFileStateTable)
        .values({
          project_id: projectID,
          file_path: filePath,
          content_hash: hash,
          last_indexed: Date.now(),
          node_count: result.nodes.length,
        })
        .run()
    })

    log.info("indexed file", {
      file: relativePath,
      nodes: result.nodes.length,
      edges: result.edges.length,
    })

    return result.nodes.length
  }

  /**
   * Removes all graph data for a file.
   *
   * @param filePath - Absolute path to the removed file
   * @param projectID - Project identifier
   */
  export async function removeFile(filePath: string, projectID: string): Promise<void> {
    const relativePath = path.relative(Instance.worktree, filePath)
    Database.transaction((tx) => {
      tx.delete(GraphEdgeTable)
        .where(and(eq(GraphEdgeTable.project_id, projectID), eq(GraphEdgeTable.file_path, relativePath)))
        .run()
      tx.delete(GraphNodeTable)
        .where(and(eq(GraphNodeTable.project_id, projectID), eq(GraphNodeTable.file_path, relativePath)))
        .run()
      tx.delete(GraphFileStateTable)
        .where(and(eq(GraphFileStateTable.project_id, projectID), eq(GraphFileStateTable.file_path, filePath)))
        .run()
    })
  }

  /**
   * Performs a full index of the project, scanning all supported source files.
   *
   * Uses ripgrep to discover files (respects .gitignore), then indexes
   * each supported file in sequence.
   *
   * @param projectID - Project identifier
   * @param directory - Project root directory
   * @returns Summary of indexing results
   */
  export async function indexProject(
    projectID: string,
    directory: string,
  ): Promise<{ indexed: number; skipped: number; total: number; errors: number }> {
    log.info("starting full project index", { directory })

    // Build glob patterns for supported extensions
    const extensions = [
      "ts", "tsx", "js", "jsx", "mjs", "cjs",
      "py", "go", "rs", "java", "rb",
      "c", "h", "cpp", "cc", "cxx", "hpp",
      "cs", "php",
    ]
    const globs = extensions.map((ext) => `*.${ext}`)

    const files: string[] = []
    for await (const file of Ripgrep.files({ cwd: directory, glob: globs })) {
      files.push(path.resolve(directory, file))
    }

    let indexed = 0
    let skipped = 0
    let errors = 0

    for (const file of files) {
      try {
        const count = await indexFile(file, projectID)
        if (count === -1) {
          skipped++
        } else {
          indexed++
        }
      } catch (err) {
        errors++
        log.warn("failed to index file", { file, error: err })
      }
    }

    const result = { indexed, skipped, total: files.length, errors }
    log.info("project index complete", result)
    return result
  }

  /**
   * Resolves cross-file edges by matching import paths to actual files
   * and linking imported symbols to their definitions.
   *
   * After individual files are indexed, import edges reference module paths
   * (e.g., `"./utils"`, `"@/config"`). This pass:
   * 1. Resolves import paths to actual file paths in the project
   * 2. Creates `used_by` edges from the definition to the import site
   * 3. Creates `tested_by` edges for test file imports of source files
   *
   * @param projectID - Project identifier
   * @returns Number of edges resolved
   */
  export async function resolveEdges(projectID: string): Promise<number> {
    // Get all nodes indexed by name for this project
    const allNodes = Database.use((db) =>
      db
        .select({
          id: GraphNodeTable.id,
          name: GraphNodeTable.name,
          filePath: GraphNodeTable.file_path,
          kind: GraphNodeTable.kind,
        })
        .from(GraphNodeTable)
        .where(eq(GraphNodeTable.project_id, projectID))
        .all(),
    )

    // Build index: name → nodes (for cross-file symbol matching)
    const nodesByName = new Map<string, { id: string; filePath: string; kind: string }[]>()
    for (const node of allNodes) {
      const list = nodesByName.get(node.name) ?? []
      list.push({ id: node.id, filePath: node.filePath, kind: node.kind })
      nodesByName.set(node.name, list)
    }

    // Build index: filePath → nodes (for import resolution)
    const nodesByFile = new Map<string, { id: string; name: string; kind: string }[]>()
    for (const node of allNodes) {
      const list = nodesByFile.get(node.filePath) ?? []
      list.push({ id: node.id, name: node.name, kind: node.kind })
      nodesByFile.set(node.filePath, list)
    }

    // Collect all indexed file paths for resolution
    const indexedFiles = new Set<string>()
    for (const node of allNodes) {
      indexedFiles.add(node.filePath)
    }

    // Get all import edges
    const importEdges = Database.use((db) =>
      db
        .select()
        .from(GraphEdgeTable)
        .where(and(eq(GraphEdgeTable.project_id, projectID), eq(GraphEdgeTable.kind, "imports")))
        .all(),
    )

    let resolved = 0

    // Resolve import edges → used_by edges
    Database.transaction((tx) => {
      for (const edge of importEdges) {
        // The source is the imported symbol name, target is the module path
        const importedName = allNodes.find((n) => n.id === edge.source_node_id)?.name
        if (!importedName) continue

        // Find the target module path from the edge's target node
        const targetNode = allNodes.find((n) => n.id === edge.target_node_id)
        const importPath = targetNode?.name

        if (!importPath) continue

        // Resolve import path to a file
        const resolvedFile = resolveImportPath(importPath, edge.file_path, indexedFiles)
        if (!resolvedFile) continue

        // Find the definition of the imported symbol in the resolved file
        const fileNodes = nodesByFile.get(resolvedFile) ?? []
        const definition = fileNodes.find(
          (n) => n.name === importedName && n.kind !== "import" && n.kind !== "export",
        )
        if (!definition) continue

        // Create used_by edge: definition → import site
        tx.insert(GraphEdgeTable)
          .values({
            id: ulid(),
            project_id: projectID,
            source_node_id: definition.id,
            target_node_id: edge.source_node_id,
            kind: "used_by",
            file_path: edge.file_path,
            line: edge.line,
          })
          .run()

        // If the importing file is a test file, also create tested_by edge
        if (isTestFilePath(edge.file_path)) {
          tx.insert(GraphEdgeTable)
            .values({
              id: ulid(),
              project_id: projectID,
              source_node_id: definition.id,
              target_node_id: edge.source_node_id,
              kind: "tested_by",
              file_path: edge.file_path,
              line: edge.line,
            })
            .run()
        }

        resolved++
      }
    })

    log.info("edge resolution complete", { resolved, totalEdges: importEdges.length })
    return resolved
  }

  /**
   * Resolves an import path to an indexed file path.
   *
   * Handles:
   * - Relative paths: `./utils`, `../config`
   * - Extension resolution: tries .ts, .tsx, .js, .jsx, /index.ts, etc.
   * - Path alias stripping: `@/foo` → `src/foo`
   *
   * @param importPath - The import path string
   * @param fromFile - The file doing the importing (relative path)
   * @param indexedFiles - Set of all indexed file paths
   * @returns Resolved file path, or undefined
   */
  function resolveImportPath(
    importPath: string,
    fromFile: string,
    indexedFiles: Set<string>,
  ): string | undefined {
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs"]
    const indexFiles = extensions.map((ext) => `/index${ext}`)

    // Handle relative imports
    if (importPath.startsWith("./") || importPath.startsWith("../")) {
      const dir = path.dirname(fromFile)
      const resolved = path.normalize(path.join(dir, importPath))
      return tryResolve(resolved, indexedFiles, extensions, indexFiles)
    }

    // Handle path alias (common patterns: @/..., ~/...)
    if (importPath.startsWith("@/") || importPath.startsWith("~/")) {
      const stripped = importPath.slice(2)
      // Try src/ prefix (most common convention)
      for (const prefix of ["src/", ""]) {
        const candidate = prefix + stripped
        const result = tryResolve(candidate, indexedFiles, extensions, indexFiles)
        if (result) return result
      }
    }

    // Try as-is (bare specifier that might match a project file)
    return tryResolve(importPath, indexedFiles, extensions, indexFiles)
  }

  /**
   * Tries various extension/index combinations to resolve a path.
   */
  function tryResolve(
    basePath: string,
    indexedFiles: Set<string>,
    extensions: string[],
    indexFiles: string[],
  ): string | undefined {
    // Direct match
    if (indexedFiles.has(basePath)) return basePath

    // Try with extensions
    for (const ext of extensions) {
      const withExt = basePath + ext
      if (indexedFiles.has(withExt)) return withExt
    }

    // Try index files
    for (const idx of indexFiles) {
      const withIndex = basePath + idx
      if (indexedFiles.has(withIndex)) return withIndex
    }

    return undefined
  }

  /**
   * Quick test file detection (mirrors Graph.isTestFile without circular import).
   */
  function isTestFilePath(filePath: string): boolean {
    const basename = filePath.split("/").pop() ?? ""
    if (/\.(test|spec)\.\w+$/.test(basename)) return true
    if (basename.endsWith("_test.go") || basename.endsWith("_test.py")) return true
    if (basename.startsWith("test_") && basename.endsWith(".py")) return true
    const parts = filePath.split("/")
    return parts.some((p) => p === "test" || p === "tests" || p === "__tests__" || p === "spec")
  }
}
