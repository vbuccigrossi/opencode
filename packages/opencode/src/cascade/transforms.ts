import { Log } from "@/util/log"

/**
 * Call-site transformers — given a function call expression string,
 * applies a signature change (add/remove/reorder/rename parameter).
 *
 * Each transform takes the raw call arguments string and produces
 * the updated arguments string.
 */
export namespace CascadeTransforms {
  const log = Log.create({ service: "cascade.transforms" })

  /** Available transform types. */
  export type TransformType =
    | "add_param"
    | "remove_param"
    | "rename_param"
    | "reorder_params"
    | "change_type"

  /** Details for add_param transform. */
  export interface AddParamDetails {
    /** Position to insert (0-based). -1 means append. */
    position: number
    /** Default value expression to insert. */
    defaultValue: string
    /** Name of the new parameter (for documentation). */
    name?: string
  }

  /** Details for remove_param transform. */
  export interface RemoveParamDetails {
    /** Position to remove (0-based). */
    position: number
  }

  /** Details for rename_param transform (object-style params). */
  export interface RenameParamDetails {
    /** Old property name. */
    oldName: string
    /** New property name. */
    newName: string
  }

  /** Details for reorder_params transform. */
  export interface ReorderParamsDetails {
    /** New order as array of original positions (0-based). */
    newOrder: number[]
  }

  /** Details for change_type (informational only). */
  export interface ChangeTypeDetails {
    /** Description of the type change. */
    description: string
  }

  /** Union of all transform details. */
  export type TransformDetails =
    | { type: "add_param" } & AddParamDetails
    | { type: "remove_param" } & RemoveParamDetails
    | { type: "rename_param" } & RenameParamDetails
    | { type: "reorder_params" } & ReorderParamsDetails
    | { type: "change_type" } & ChangeTypeDetails

  /** Result of transforming a single call site. */
  export interface TransformResult {
    /** Original call expression. */
    original: string
    /** Transformed call expression. */
    transformed: string
    /** Line number in the file (1-based). */
    line: number
    /** Description of what changed. */
    description: string
  }

  /**
   * Find and transform all call sites of a function in file content.
   *
   * @param content - File content to scan
   * @param functionName - Name of the function being called
   * @param transform - Transform to apply
   * @returns Array of transform results, plus the new file content
   */
  export function transformCallSites(
    content: string,
    functionName: string,
    transform: TransformDetails,
  ): { results: TransformResult[]; newContent: string } {
    if (transform.type === "change_type") {
      return { results: [], newContent: content }
    }

    const lines = content.split("\n")
    const results: TransformResult[] = []
    const newLines: string[] = []

    // Build a regex that matches functionName( with word boundary
    const callPattern = new RegExp(`\\b${escapeRegex(functionName)}\\s*\\(`, "g")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      callPattern.lastIndex = 0

      if (!callPattern.test(line)) {
        newLines.push(line)
        continue
      }

      // Found a call — extract the full call expression
      callPattern.lastIndex = 0
      let newLine = line
      let match: RegExpExecArray | null
      const lineResults: TransformResult[] = []

      // Process matches from right to left to preserve positions
      const matches: { index: number; length: number }[] = []
      while ((match = callPattern.exec(line)) !== null) {
        const callStart = match.index + match[0].length - 1 // Position of opening paren
        const callEnd = findMatchingParen(line, callStart)
        if (callEnd < 0) continue
        matches.push({ index: callStart, length: callEnd - callStart + 1 })
      }

      // Apply transforms right-to-left
      for (let j = matches.length - 1; j >= 0; j--) {
        const { index: parenStart, length: parenLen } = matches[j]
        const argsStr = line.slice(parenStart + 1, parenStart + parenLen - 1)
        const args = splitArgs(argsStr)

        const newArgs = applyTransform(args, transform)
        if (newArgs === null) continue

        const originalExpr = `${functionName}(${argsStr})`
        const newArgsStr = newArgs.join(", ")
        const transformedExpr = `${functionName}(${newArgsStr})`

        // Replace in the line
        newLine = newLine.slice(0, parenStart + 1) + newArgsStr + newLine.slice(parenStart + parenLen - 1)

        lineResults.push({
          original: originalExpr,
          transformed: transformedExpr,
          line: i + 1,
          description: describeTransform(transform),
        })
      }

      newLines.push(newLine)
      results.push(...lineResults)
    }

    return {
      results,
      newContent: newLines.join("\n"),
    }
  }

  /**
   * Apply a transform to an arguments array.
   *
   * @param args - Current arguments
   * @param transform - Transform to apply
   * @returns New arguments array, or null if no change needed
   */
  export function applyTransform(
    args: string[],
    transform: TransformDetails,
  ): string[] | null {
    switch (transform.type) {
      case "add_param": {
        const newArgs = [...args]
        const pos = transform.position < 0 ? args.length : transform.position
        newArgs.splice(pos, 0, transform.defaultValue)
        return newArgs
      }

      case "remove_param": {
        if (transform.position < 0 || transform.position >= args.length) return null
        const newArgs = [...args]
        newArgs.splice(transform.position, 1)
        return newArgs
      }

      case "rename_param": {
        // For object-style params like { oldName: value }
        const newArgs = args.map((arg) => {
          const trimmed = arg.trim()
          // Match: oldName: value or oldName (shorthand)
          const propPattern = new RegExp(`^(\\s*)${escapeRegex(transform.oldName)}(\\s*:\\s*|\\s*$)`)
          if (propPattern.test(trimmed)) {
            return arg.replace(transform.oldName, transform.newName)
          }
          return arg
        })
        const changed = newArgs.some((a, i) => a !== args[i])
        return changed ? newArgs : null
      }

      case "reorder_params": {
        if (transform.newOrder.length !== args.length) return null
        const newArgs = transform.newOrder.map((idx) => args[idx])
        const changed = newArgs.some((a, i) => a !== args[i])
        return changed ? newArgs : null
      }

      case "change_type":
        return null
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Find the matching closing paren, respecting nesting. */
  export function findMatchingParen(str: string, openPos: number): number {
    let depth = 0
    let inString: string | null = null

    for (let i = openPos; i < str.length; i++) {
      const ch = str[i]

      // Track string literals
      if (inString) {
        if (ch === inString && str[i - 1] !== "\\") inString = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch
        continue
      }

      if (ch === "(") depth++
      if (ch === ")") {
        depth--
        if (depth === 0) return i
      }
    }

    return -1
  }

  /** Split arguments respecting nesting and string literals. */
  export function splitArgs(argsStr: string): string[] {
    if (!argsStr.trim()) return []

    const args: string[] = []
    let current = ""
    let depth = 0
    let inString: string | null = null

    for (let i = 0; i < argsStr.length; i++) {
      const ch = argsStr[i]

      if (inString) {
        current += ch
        if (ch === inString && argsStr[i - 1] !== "\\") inString = null
        continue
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch
        current += ch
        continue
      }

      if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
        depth++
        current += ch
      } else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
        depth--
        current += ch
      } else if (ch === "," && depth === 0) {
        args.push(current.trim())
        current = ""
      } else {
        current += ch
      }
    }

    if (current.trim()) args.push(current.trim())
    return args
  }

  /** Escape regex special characters. */
  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  /** Describe a transform in human-readable terms. */
  function describeTransform(transform: TransformDetails): string {
    switch (transform.type) {
      case "add_param":
        return `Add parameter${transform.name ? ` '${transform.name}'` : ""} at position ${transform.position < 0 ? "end" : transform.position} with default '${transform.defaultValue}'`
      case "remove_param":
        return `Remove parameter at position ${transform.position}`
      case "rename_param":
        return `Rename parameter '${transform.oldName}' to '${transform.newName}'`
      case "reorder_params":
        return `Reorder parameters to [${transform.newOrder.join(", ")}]`
      case "change_type":
        return `Type change: ${transform.description}`
    }
  }
}
