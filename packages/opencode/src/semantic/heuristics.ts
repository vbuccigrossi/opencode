import { Log } from "@/util/log"

/**
 * Heuristic extraction for semantic code understanding.
 *
 * Analyzes source code text to extract behavioral signals:
 * JSDoc/docstrings, parameter types, return types, side effects,
 * error throws, and complexity indicators.
 *
 * Pure text analysis — no AST required.
 */
export namespace Heuristics {
  const log = Log.create({ service: "semantic.heuristics" })

  /** Extracted signals from a function/symbol. */
  export interface Signals {
    /** JSDoc or docstring description. */
    docstring?: string
    /** Parameter info from signature. */
    params: Array<{ name: string; type?: string; optional: boolean }>
    /** Return type from signature. */
    returnType?: string
    /** Whether the function is async. */
    isAsync: boolean
    /** Whether the function is a generator. */
    isGenerator: boolean
    /** Detected side effects. */
    sideEffects: string[]
    /** Detected error/throw conditions. */
    throws: string[]
    /** Complexity indicators. */
    complexity: {
      lines: number
      branches: number    // if/else/switch/ternary count
      loops: number       // for/while/do count
      tryCatch: number
    }
  }

  /** Side effect patterns to detect in function bodies. */
  const SIDE_EFFECT_PATTERNS: Array<[RegExp, string]> = [
    // File system
    [/\b(readFile|writeFile|readdir|mkdir|unlink|rmdir|rename|copyFile|stat|access)\b/, "file I/O"],
    [/\b(createReadStream|createWriteStream|appendFile)\b/, "file I/O"],
    [/\bfs\.\w+/, "file I/O"],
    // Network
    [/\b(fetch|axios|http\.request|https\.request)\b/, "network request"],
    [/\b(XMLHttpRequest|WebSocket)\b/, "network request"],
    // Console/logging
    [/\bconsole\.(log|error|warn|info|debug)\b/, "console output"],
    [/\blog\.(info|warn|error|debug)\b/, "logging"],
    // Database
    [/\b(query|execute|select|insert|update|delete|findOne|findMany|create)\b.*\b(db|database|sql|prisma|drizzle|mongoose|sequelize)\b/i, "database operation"],
    [/\bDatabase\.\w+/, "database operation"],
    // Process/system
    [/\b(process\.exit|spawn|exec|execSync)\b/, "process/system"],
    [/\bchild_process\b/, "process/system"],
    // State mutation
    [/\bthis\.\w+\s*=/, "state mutation"],
    [/\.set\(|\.delete\(|\.push\(|\.splice\(/, "collection mutation"],
    // Event emission
    [/\b(emit|dispatch|publish|send|notify)\b/, "event emission"],
    // Cache/storage
    [/\b(localStorage|sessionStorage|cache|redis)\b/i, "storage operation"],
  ]

  /** Error/throw patterns. */
  const THROW_PATTERNS: Array<[RegExp, string]> = [
    [/throw\s+new\s+(\w+Error)\s*\(([^)]*)\)/, "throws $1"],
    [/throw\s+new\s+Error\s*\(([^)]*)\)/, "throws Error"],
    [/throw\s+new\s+(\w+)\s*\(([^)]*)\)/, "throws $1"],
    [/reject\s*\(/, "may reject"],
  ]

  /**
   * Extract signals from a function's source code.
   *
   * @param source - The function's full source code (including signature)
   * @param precedingComment - Any comment block before the function
   * @returns Extracted signals
   */
  export function extract(source: string, precedingComment?: string): Signals {
    const lines = source.split("\n")

    return {
      docstring: extractDocstring(precedingComment ?? source),
      params: extractParams(source),
      returnType: extractReturnType(source),
      isAsync: /\basync\b/.test(source.split("\n")[0] ?? ""),
      isGenerator: /\bfunction\s*\*/.test(source) || /\byield\b/.test(source),
      sideEffects: extractSideEffects(source),
      throws: extractThrows(source),
      complexity: measureComplexity(lines),
    }
  }

  /**
   * Generate a behavioral summary from signals.
   *
   * @param name - Symbol name
   * @param kind - Symbol kind
   * @param signals - Extracted signals
   * @returns 1-2 sentence behavioral description
   */
  export function summarize(
    name: string,
    kind: "function" | "class" | "module" | "namespace",
    signals: Signals,
  ): string {
    const parts: string[] = []

    // Start with docstring if available
    if (signals.docstring) {
      // Use first sentence of docstring
      const firstSentence = signals.docstring.split(/[.!]\s/)[0]
      if (firstSentence && firstSentence.length < 150) {
        return firstSentence + (firstSentence.endsWith(".") ? "" : ".")
      }
    }

    // Build from signals
    const asyncPrefix = signals.isAsync ? "Async " : ""
    const kindLabel = kind === "function" ? "function" : kind

    if (signals.params.length > 0) {
      const paramNames = signals.params.map((p) => p.name).join(", ")
      parts.push(`${asyncPrefix}${kindLabel} that takes ${paramNames}`)
    } else {
      parts.push(`${asyncPrefix}${kindLabel}`)
    }

    if (signals.returnType && signals.returnType !== "void" && signals.returnType !== "undefined") {
      parts.push(`returns ${signals.returnType}`)
    }

    if (signals.sideEffects.length > 0) {
      const unique = [...new Set(signals.sideEffects)]
      parts.push(`performs ${unique.join(", ")}`)
    }

    if (signals.throws.length > 0) {
      parts.push(`may throw on error`)
    }

    const complexityLabel = getComplexityLabel(signals.complexity)
    if (complexityLabel === "complex") {
      parts.push(`(complex: ${signals.complexity.lines} lines, ${signals.complexity.branches} branches)`)
    }

    return parts.join("; ") + "."
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Extract JSDoc or docstring from comment block. */
  function extractDocstring(text: string): string | undefined {
    // JSDoc: /** ... */
    const jsdocMatch = text.match(/\/\*\*\s*([\s\S]*?)\s*\*\//)
    if (jsdocMatch) {
      return jsdocMatch[1]
        .replace(/^\s*\*\s?/gm, "") // Remove leading * from each line
        .replace(/@\w+\s.*$/gm, "") // Remove @param, @returns, etc.
        .trim()
        .split("\n")[0] // First line only
        ?.trim()
    }

    // Python docstring: """...""" or '''...'''
    const pyMatch = text.match(/(?:"""|''')([\s\S]*?)(?:"""|''')/)
    if (pyMatch) {
      return pyMatch[1].trim().split("\n")[0]?.trim()
    }

    // Single-line comment: // description
    const lineMatch = text.match(/\/\/\s*(.+)/)
    if (lineMatch) {
      return lineMatch[1].trim()
    }

    return undefined
  }

  /** Extract parameters from function signature. */
  function extractParams(source: string): Array<{ name: string; type?: string; optional: boolean }> {
    // Match function signature's parameter list
    const sigMatch = source.match(/(?:function\s+\w+|=>\s*|(?:async\s+)?(?:function\s*)?)\s*\(([^)]*)\)/)
    if (!sigMatch) {
      // Try arrow function: (params) => or param =>
      const arrowMatch = source.match(/\(([^)]*)\)\s*(?::\s*\w+)?\s*=>/)
      if (!arrowMatch) return []
      return parseParamList(arrowMatch[1])
    }
    return parseParamList(sigMatch[1])
  }

  /** Parse a parameter list string into structured params. */
  function parseParamList(paramStr: string): Array<{ name: string; type?: string; optional: boolean }> {
    if (!paramStr.trim()) return []

    return paramStr
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => {
        // Handle destructuring — simplify
        if (p.startsWith("{") || p.startsWith("[")) {
          return { name: p.slice(0, 20), type: "object", optional: p.includes("?") }
        }

        const optional = p.includes("?")
        const cleaned = p.replace("?", "")

        // name: Type = default
        const parts = cleaned.split(/\s*:\s*/)
        const name = parts[0]?.replace(/\s*=.*$/, "").trim() ?? p
        const type = parts[1]?.replace(/\s*=.*$/, "").trim()

        return { name, type, optional: optional || p.includes("=") }
      })
  }

  /** Extract return type from function signature. */
  function extractReturnType(source: string): string | undefined {
    // function name(params): ReturnType
    const match = source.match(/\)\s*:\s*([^{=]+?)(?:\s*[{=]|\s*$)/)
    if (match) {
      const type = match[1].trim()
      if (type.length > 0 && type.length < 100) return type
    }
    return undefined
  }

  /** Detect side effects in function body. */
  function extractSideEffects(source: string): string[] {
    const effects: string[] = []
    for (const [pattern, label] of SIDE_EFFECT_PATTERNS) {
      if (pattern.test(source)) {
        effects.push(label)
      }
    }
    return [...new Set(effects)]
  }

  /** Detect throw/error conditions. */
  function extractThrows(source: string): string[] {
    const throws: string[] = []
    for (const [pattern, label] of THROW_PATTERNS) {
      const match = source.match(pattern)
      if (match) {
        throws.push(label.replace("$1", match[1] ?? "Error"))
      }
    }
    return [...new Set(throws)]
  }

  /** Measure code complexity indicators. */
  function measureComplexity(lines: string[]): Signals["complexity"] {
    let branches = 0
    let loops = 0
    let tryCatch = 0

    for (const line of lines) {
      const trimmed = line.trim()
      if (/^\s*(if|else if|else|case|default)\b/.test(trimmed)) branches++
      if (/\?\s*[^:]+\s*:/.test(trimmed)) branches++ // ternary
      if (/^\s*(for|while|do)\b/.test(trimmed)) loops++
      if (/^\s*(try|catch|finally)\b/.test(trimmed)) tryCatch++
    }

    return { lines: lines.length, branches, loops, tryCatch }
  }

  /** Get complexity label from measurements. */
  function getComplexityLabel(c: Signals["complexity"]): "simple" | "moderate" | "complex" {
    const score = c.lines * 0.1 + c.branches * 2 + c.loops * 3 + c.tryCatch * 1
    if (score < 5) return "simple"
    if (score < 15) return "moderate"
    return "complex"
  }
}
