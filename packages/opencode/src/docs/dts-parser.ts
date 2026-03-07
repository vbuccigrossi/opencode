import { Log } from "@/util/log"

/**
 * TypeScript .d.ts file parser for documentation retrieval.
 *
 * Extracts exported type information (functions, interfaces, types,
 * classes, constants) from TypeScript declaration files.
 */
export namespace DtsParser {
  const log = Log.create({ service: "docs.dts-parser" })

  /** Parsed type information. */
  export interface TypeInfo {
    /** Symbol name. */
    name: string
    /** Kind of symbol. */
    kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "namespace"
    /** Full type signature (single line). */
    signature: string
    /** JSDoc description, if any. */
    description?: string
    /** Parameters (for functions). */
    parameters?: Array<{
      name: string
      type: string
      optional: boolean
      description?: string
    }>
    /** Return type (for functions). */
    returnType?: string
    /** Source package or file. */
    source: string
  }

  /**
   * Parse a .d.ts file content and extract type information.
   *
   * @param content - File content
   * @param source - Source package/file name
   * @returns Array of extracted type info
   */
  export function parse(content: string, source: string): TypeInfo[] {
    const results: TypeInfo[] = []
    const lines = content.split("\n")

    let currentComment = ""
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      const trimmed = line.trim()

      // Collect JSDoc comments
      if (trimmed.startsWith("/**")) {
        currentComment = ""
        while (i < lines.length && !lines[i].includes("*/")) {
          currentComment += lines[i] + "\n"
          i++
        }
        if (i < lines.length) currentComment += lines[i]
        i++
        continue
      }

      // Skip non-export lines
      if (!trimmed.startsWith("export ") && !trimmed.startsWith("declare ")) {
        currentComment = ""
        i++
        continue
      }

      // Parse the export
      const info = parseExportLine(trimmed, currentComment, source)
      if (info) {
        results.push(info)
      }

      currentComment = ""
      i++
    }

    return results
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Parse a single export line. */
  function parseExportLine(line: string, comment: string, source: string): TypeInfo | undefined {
    const description = extractDescription(comment)

    // export function name(params): ReturnType
    const funcMatch = line.match(/(?:export|declare)\s+function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*:\s*(.+?)\s*;?\s*$/)
    if (funcMatch) {
      const params = parseParams(funcMatch[3], comment)
      return {
        name: funcMatch[1],
        kind: "function",
        signature: line.replace(/^(?:export|declare)\s+/, "").trim(),
        description,
        parameters: params,
        returnType: funcMatch[4].replace(/;$/, "").trim(),
        source,
      }
    }

    // export interface Name
    const ifaceMatch = line.match(/(?:export|declare)\s+interface\s+(\w+)/)
    if (ifaceMatch) {
      return {
        name: ifaceMatch[1],
        kind: "interface",
        signature: line.replace(/^(?:export|declare)\s+/, "").replace(/\{.*/, "").trim(),
        description,
        source,
      }
    }

    // export type Name = ...
    const typeMatch = line.match(/(?:export|declare)\s+type\s+(\w+)/)
    if (typeMatch) {
      return {
        name: typeMatch[1],
        kind: "type",
        signature: line.replace(/^(?:export|declare)\s+/, "").trim(),
        description,
        source,
      }
    }

    // export class Name
    const classMatch = line.match(/(?:export|declare)\s+class\s+(\w+)/)
    if (classMatch) {
      return {
        name: classMatch[1],
        kind: "class",
        signature: line.replace(/^(?:export|declare)\s+/, "").replace(/\{.*/, "").trim(),
        description,
        source,
      }
    }

    // export const name: Type
    const constMatch = line.match(/(?:export|declare)\s+const\s+(\w+)\s*:\s*(.+?)(?:\s*;|\s*=)/)
    if (constMatch) {
      return {
        name: constMatch[1],
        kind: "const",
        signature: `const ${constMatch[1]}: ${constMatch[2].trim()}`,
        description,
        source,
      }
    }

    // export enum Name
    const enumMatch = line.match(/(?:export|declare)\s+enum\s+(\w+)/)
    if (enumMatch) {
      return {
        name: enumMatch[1],
        kind: "enum",
        signature: line.replace(/^(?:export|declare)\s+/, "").replace(/\{.*/, "").trim(),
        description,
        source,
      }
    }

    // export namespace Name
    const nsMatch = line.match(/(?:export|declare)\s+namespace\s+(\w+)/)
    if (nsMatch) {
      return {
        name: nsMatch[1],
        kind: "namespace",
        signature: `namespace ${nsMatch[1]}`,
        description,
        source,
      }
    }

    return undefined
  }

  /** Extract description from JSDoc comment. */
  function extractDescription(comment: string): string | undefined {
    if (!comment) return undefined

    const cleaned = comment
      .replace(/\/\*\*\s*/g, "")
      .replace(/\s*\*\//g, "")
      .replace(/^\s*\*\s?/gm, "")
      .replace(/@\w+\s.*/g, "")
      .trim()

    const firstLine = cleaned.split("\n")[0]?.trim()
    return firstLine && firstLine.length > 0 ? firstLine : undefined
  }

  /** Parse parameters from function signature and JSDoc. */
  function parseParams(
    paramStr: string,
    comment: string,
  ): TypeInfo["parameters"] {
    if (!paramStr.trim()) return []

    const params: NonNullable<TypeInfo["parameters"]> = []

    // Parse @param tags from comment
    const paramDocs = new Map<string, string>()
    const paramPattern = /@param\s+(?:\{[^}]+\}\s+)?(\w+)\s*[-—]?\s*(.*)/g
    let match
    while ((match = paramPattern.exec(comment)) !== null) {
      paramDocs.set(match[1], match[2].trim())
    }

    // Parse parameter list
    for (const part of splitParams(paramStr)) {
      const trimmed = part.trim()
      if (!trimmed) continue

      const optional = trimmed.includes("?")
      const cleaned = trimmed.replace("?", "")
      const colonIdx = cleaned.indexOf(":")

      if (colonIdx > 0) {
        const name = cleaned.slice(0, colonIdx).trim()
        const type = cleaned.slice(colonIdx + 1).trim()
        params.push({
          name,
          type,
          optional,
          description: paramDocs.get(name),
        })
      } else {
        params.push({
          name: cleaned.trim(),
          type: "any",
          optional,
          description: paramDocs.get(cleaned.trim()),
        })
      }
    }

    return params
  }

  /** Split parameter string respecting nested generics. */
  function splitParams(str: string): string[] {
    const parts: string[] = []
    let depth = 0
    let current = ""

    for (const ch of str) {
      if (ch === "<" || ch === "(") depth++
      if (ch === ">" || ch === ")") depth--
      if (ch === "," && depth === 0) {
        parts.push(current)
        current = ""
      } else {
        current += ch
      }
    }

    if (current.trim()) parts.push(current)
    return parts
  }
}
