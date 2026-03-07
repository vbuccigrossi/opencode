import { Log } from "@/util/log"

/**
 * Edge case generators for test generation.
 *
 * Given a parameter type, generates interesting test values that
 * exercise boundary conditions, error paths, and corner cases.
 */
export namespace EdgeCases {
  const log = Log.create({ service: "testgen.edge-cases" })

  /** A generated test value. */
  export interface TestValue {
    /** JavaScript expression for the value. */
    expression: string
    /** Description of why this value is interesting. */
    reason: string
  }

  /**
   * Generate edge case values for a given type.
   *
   * @param typeName - The TypeScript type name
   * @param paramName - The parameter name (for context)
   * @returns Array of interesting test values
   */
  export function forType(typeName: string, paramName?: string): TestValue[] {
    const normalized = normalizeType(typeName)

    switch (normalized) {
      case "string":
        return stringCases(paramName)
      case "number":
        return numberCases(paramName)
      case "boolean":
        return booleanCases()
      case "array":
        return arrayCases(typeName)
      case "object":
        return objectCases()
      case "optional":
        return optionalCases(typeName)
      case "promise":
        return [] // Can't generate edge cases for Promise directly
      default:
        return genericCases(typeName)
    }
  }

  /**
   * Generate a "happy path" value for a type.
   *
   * @param typeName - The TypeScript type name
   * @returns A reasonable default value expression
   */
  export function defaultValue(typeName: string): string {
    const normalized = normalizeType(typeName)
    switch (normalized) {
      case "string": return '"test"'
      case "number": return "42"
      case "boolean": return "true"
      case "array": return "[1, 2, 3]"
      case "object": return "{ key: 'value' }"
      case "optional": return "undefined"
      default: return "{}"
    }
  }

  // ─── Type-specific generators ─────────────────────────────────

  function stringCases(paramName?: string): TestValue[] {
    const cases: TestValue[] = [
      { expression: '""', reason: "empty string" },
      { expression: '"a"', reason: "single character" },
      { expression: '"hello world"', reason: "normal string" },
    ]

    // Context-aware values
    if (paramName?.toLowerCase().includes("path") || paramName?.toLowerCase().includes("file")) {
      cases.push({ expression: '"/tmp/test.txt"', reason: "file path" })
      cases.push({ expression: '"../relative/path"', reason: "relative path" })
    }

    if (paramName?.toLowerCase().includes("url")) {
      cases.push({ expression: '"https://example.com"', reason: "valid URL" })
      cases.push({ expression: '"not-a-url"', reason: "invalid URL" })
    }

    if (paramName?.toLowerCase().includes("email")) {
      cases.push({ expression: '"user@example.com"', reason: "valid email" })
      cases.push({ expression: '"invalid"', reason: "invalid email" })
    }

    cases.push({ expression: '"a".repeat(1000)', reason: "very long string" })
    cases.push({ expression: '"<script>alert(1)</script>"', reason: "special characters" })

    return cases
  }

  function numberCases(paramName?: string): TestValue[] {
    const cases: TestValue[] = [
      { expression: "0", reason: "zero" },
      { expression: "1", reason: "one" },
      { expression: "-1", reason: "negative" },
      { expression: "42", reason: "typical positive" },
      { expression: "Number.MAX_SAFE_INTEGER", reason: "max safe integer" },
      { expression: "0.1 + 0.2", reason: "floating point precision" },
    ]

    if (paramName?.toLowerCase().includes("index") || paramName?.toLowerCase().includes("offset")) {
      cases.push({ expression: "-1", reason: "negative index" })
      cases.push({ expression: "0", reason: "first index" })
    }

    if (paramName?.toLowerCase().includes("count") || paramName?.toLowerCase().includes("limit")) {
      cases.push({ expression: "0", reason: "zero count" })
      cases.push({ expression: "1000000", reason: "very large count" })
    }

    return cases
  }

  function booleanCases(): TestValue[] {
    return [
      { expression: "true", reason: "truthy" },
      { expression: "false", reason: "falsy" },
    ]
  }

  function arrayCases(typeName: string): TestValue[] {
    return [
      { expression: "[]", reason: "empty array" },
      { expression: "[1]", reason: "single element" },
      { expression: "[1, 2, 3]", reason: "multiple elements" },
      { expression: "Array.from({ length: 100 }, (_, i) => i)", reason: "large array" },
    ]
  }

  function objectCases(): TestValue[] {
    return [
      { expression: "{}", reason: "empty object" },
      { expression: "{ key: 'value' }", reason: "simple object" },
    ]
  }

  function optionalCases(typeName: string): TestValue[] {
    // Extract the inner type from "Type | undefined" or "Type?"
    const inner = typeName.replace(/\s*\|\s*undefined/, "").replace(/\?$/, "").trim()
    const innerCases = forType(inner)

    return [
      { expression: "undefined", reason: "not provided" },
      ...innerCases.slice(0, 3), // Include some inner type cases
    ]
  }

  function genericCases(typeName: string): TestValue[] {
    return [
      { expression: "{}", reason: "empty object as fallback" },
    ]
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Normalize a type string to a category. */
  function normalizeType(typeName: string): string {
    const cleaned = typeName.trim().toLowerCase()

    if (cleaned === "string") return "string"
    if (cleaned === "number" || cleaned === "bigint") return "number"
    if (cleaned === "boolean") return "boolean"
    if (cleaned.endsWith("[]") || cleaned.startsWith("array<")) return "array"
    if (cleaned.startsWith("promise<")) return "promise"
    if (cleaned.includes(" | undefined") || cleaned.endsWith("?")) return "optional"
    if (cleaned === "object" || cleaned.startsWith("{")) return "object"

    return "unknown"
  }
}
