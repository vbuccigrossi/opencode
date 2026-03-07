import { Log } from "@/util/log"
import { readFile } from "fs/promises"

/**
 * Built-in refactoring operations — rename, move, extract.
 *
 * Each operation generates a set of file edits that can be staged
 * in a refactoring plan for validation and atomic application.
 */
export namespace RefactorOps {
  const log = Log.create({ service: "refactor.operations" })

  /** A single file edit produced by a refactoring operation. */
  export interface FileEdit {
    filePath: string
    oldContent: string
    newContent: string
    description: string
  }

  /**
   * Rename a symbol across files.
   *
   * Replaces all occurrences of oldName with newName in the given files,
   * using word-boundary matching to avoid partial replacements.
   *
   * @param oldName - Current symbol name
   * @param newName - New symbol name
   * @param files - Files to scan and modify
   * @returns Array of file edits
   */
  export async function renameSymbol(
    oldName: string,
    newName: string,
    files: string[],
  ): Promise<FileEdit[]> {
    const edits: FileEdit[] = []
    // Word boundary regex for the symbol
    const pattern = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g")

    for (const filePath of files) {
      try {
        const oldContent = await readFile(filePath, "utf-8")
        if (!pattern.test(oldContent)) continue

        // Reset lastIndex for global regex
        pattern.lastIndex = 0
        const newContent = oldContent.replace(pattern, newName)

        if (newContent !== oldContent) {
          const matchCount = (oldContent.match(pattern) ?? []).length
          edits.push({
            filePath,
            oldContent,
            newContent,
            description: `Rename '${oldName}' → '${newName}' (${matchCount} occurrence${matchCount > 1 ? "s" : ""})`,
          })
        }
      } catch (err: any) {
        log.warn("rename: failed to read file", { filePath, error: err.message })
      }
    }

    return edits
  }

  /**
   * Move a function from one file to another.
   *
   * Extracts the function definition from the source file, adds it to
   * the target file, updates the import in the source file to re-export
   * from the new location, and updates imports in dependent files.
   *
   * @param fromFile - Source file path
   * @param toFile - Destination file path
   * @param functionName - Name of the function to move
   * @param dependentFiles - Files that import the function
   * @returns Array of file edits
   */
  export async function moveFunction(
    fromFile: string,
    toFile: string,
    functionName: string,
    dependentFiles: string[],
  ): Promise<FileEdit[]> {
    const edits: FileEdit[] = []

    const fromContent = await readFile(fromFile, "utf-8")
    let toContent: string
    try {
      toContent = await readFile(toFile, "utf-8")
    } catch {
      toContent = "" // New file
    }

    // Extract the function from source
    const extracted = extractFunctionBlock(fromContent, functionName)
    if (!extracted) {
      log.warn("moveFunction: function not found", { fromFile, functionName })
      return []
    }

    // Remove from source file
    const newFromContent = fromContent.replace(extracted.fullBlock, "").replace(/\n{3,}/g, "\n\n")
    edits.push({
      filePath: fromFile,
      oldContent: fromContent,
      newContent: newFromContent,
      description: `Remove '${functionName}' (moved to ${toFile.split("/").pop()})`,
    })

    // Add to target file
    const newToContent = toContent + (toContent.endsWith("\n") ? "" : "\n") + "\n" + extracted.fullBlock + "\n"
    edits.push({
      filePath: toFile,
      oldContent: toContent,
      newContent: newToContent,
      description: `Add '${functionName}' (moved from ${fromFile.split("/").pop()})`,
    })

    // Update imports in dependent files
    for (const depFile of dependentFiles) {
      try {
        const depContent = await readFile(depFile, "utf-8")
        const updatedContent = updateImportPath(depContent, functionName, fromFile, toFile)
        if (updatedContent !== depContent) {
          edits.push({
            filePath: depFile,
            oldContent: depContent,
            newContent: updatedContent,
            description: `Update import of '${functionName}' to point to new location`,
          })
        }
      } catch {}
    }

    return edits
  }

  /**
   * Extract a code block (lines) into a new named function.
   *
   * @param filePath - File to extract from
   * @param startLine - Start line (1-based)
   * @param endLine - End line (1-based)
   * @param newName - Name for the extracted function
   * @returns Array of file edits (single file)
   */
  export async function extractFunction(
    filePath: string,
    startLine: number,
    endLine: number,
    newName: string,
  ): Promise<FileEdit[]> {
    const content = await readFile(filePath, "utf-8")
    const lines = content.split("\n")

    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return []
    }

    // Extract the lines
    const extractedLines = lines.slice(startLine - 1, endLine)
    const indent = extractedLines[0]?.match(/^(\s*)/)?.[1] ?? ""
    const extractedCode = extractedLines.map((l) => l.replace(indent, "  ")).join("\n")

    // Create the new function
    const newFunction = `function ${newName}() {\n${extractedCode}\n}`

    // Replace extracted lines with function call
    const callIndent = indent
    const replacement = `${callIndent}${newName}()`

    const newLines = [
      ...lines.slice(0, startLine - 1),
      replacement,
      ...lines.slice(endLine),
      "",
      newFunction,
    ]

    return [
      {
        filePath,
        oldContent: content,
        newContent: newLines.join("\n"),
        description: `Extract lines ${startLine}-${endLine} into function '${newName}'`,
      },
    ]
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Escape special regex characters. */
  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  /** Extract a function block from file content. */
  function extractFunctionBlock(
    content: string,
    functionName: string,
  ): { fullBlock: string } | undefined {
    // Match: export [async] function name or export const name = ...
    const patterns = [
      new RegExp(`((?:\\/\\*\\*[\\s\\S]*?\\*\\/\\s*)?export\\s+(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)[^{]*\\{)`, "m"),
      new RegExp(`((?:\\/\\*\\*[\\s\\S]*?\\*\\/\\s*)?export\\s+const\\s+${escapeRegex(functionName)}\\s*=)`, "m"),
    ]

    for (const pattern of patterns) {
      const match = content.match(pattern)
      if (!match) continue

      const startIdx = match.index!
      // Find the matching closing brace
      let depth = 0
      let i = startIdx
      let foundOpen = false

      while (i < content.length) {
        if (content[i] === "{") {
          depth++
          foundOpen = true
        } else if (content[i] === "}") {
          depth--
          if (foundOpen && depth === 0) {
            return { fullBlock: content.slice(startIdx, i + 1) }
          }
        }
        i++
      }
    }

    return undefined
  }

  /** Update an import path for a moved symbol. */
  function updateImportPath(
    content: string,
    symbolName: string,
    oldPath: string,
    newPath: string,
  ): string {
    // Convert absolute paths to relative import style
    const oldImport = pathToImport(oldPath)
    const newImport = pathToImport(newPath)

    // Match import { ..., symbolName, ... } from "oldPath"
    const importPattern = new RegExp(
      `(import\\s*\\{[^}]*\\b${escapeRegex(symbolName)}\\b[^}]*\\}\\s*from\\s*["'])${escapeRegex(oldImport)}(["'])`,
      "g",
    )

    return content.replace(importPattern, `$1${newImport}$2`)
  }

  /** Convert a file path to a module import path. */
  function pathToImport(filePath: string): string {
    return filePath
      .replace(/\.(ts|tsx|js|jsx)$/, "")
      .replace(/\/index$/, "")
  }
}
