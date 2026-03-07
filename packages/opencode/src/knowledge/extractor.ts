import { Log } from "@/util/log"
import type { MessageV2 } from "@/session/message-v2"

/**
 * Fact extraction from conversation messages.
 *
 * Scans tool inputs/outputs and text parts for extractable knowledge:
 * - File roles (entry point, config, test helper, etc.)
 * - Code patterns (handler return types, naming conventions)
 * - Error patterns (error → fix mappings)
 * - Conventions (import styles, file organization)
 * - Dependencies (runtime relationships between modules)
 */
export namespace Extractor {
  const log = Log.create({ service: "knowledge.extractor" })

  /** Categories of extractable facts. */
  export type FactCategory =
    | "file_role"
    | "code_pattern"
    | "error_pattern"
    | "convention"
    | "dependency"

  /** A structured fact extracted from conversation. */
  export interface Fact {
    /** Unique identifier. */
    id: string
    /** What category this fact belongs to. */
    category: FactCategory
    /** What the fact is about (file path, symbol, pattern). */
    subject: string
    /** The fact content. */
    content: string
    /** Confidence level 0-1. */
    confidence: number
    /** How we learned this: observed from code, inferred from context, stated by user. */
    source: "observed" | "inferred" | "stated"
  }

  /** File role keywords that indicate a file's purpose. */
  const FILE_ROLE_MARKERS: Record<string, string[]> = {
    "entry point": ["entry point", "main entry", "entrypoint", "app entry"],
    "config": ["configuration", "config file", "settings"],
    "utility": ["utility", "helper", "utils", "shared helper"],
    "test helper": ["test helper", "test util", "test fixture", "mock"],
    "middleware": ["middleware", "interceptor"],
    "router": ["router", "routes", "routing"],
    "schema": ["schema", "model definition", "table definition"],
    "migration": ["migration", "database migration"],
    "types": ["type definitions", "type declarations", "interfaces"],
    "constants": ["constants", "enums", "static values"],
  }

  /** Pattern markers in think tool thoughts. */
  const PATTERN_MARKERS = [
    /all (?:handlers|functions|methods|routes) (?:in this|here) (?:project|codebase|module) (return|use|follow|have) (.+)/i,
    /the pattern (?:is|here is|used is) (.+)/i,
    /convention: (.+)/i,
    /every (.+) (?:should|must|always) (.+)/i,
    /(?:always|never|consistently) (.+)/i,
  ]

  /** Error pattern: matches "error ... fixed by ..." or "error ... solution ..." */
  const ERROR_FIX_PATTERNS = [
    /(?:error|failure|bug)(?::?\s+)["']?(.+?)["']?\s+(?:fixed by|resolved by|solution|fix was|fixed with)\s+(.+)/i,
    /(?:got|received|saw)\s+["']?(.+?)["']?\s+(?:because|due to)\s+(.+)/i,
  ]

  /**
   * Extract facts from a set of conversation messages.
   *
   * Scans think tool inputs (thoughts) and text parts for
   * recognizable patterns and statements.
   *
   * @param messages - Conversation messages to scan
   * @returns Array of extracted facts
   */
  export function extract(messages: MessageV2.WithParts[]): Fact[] {
    const facts: Fact[] = []
    let factIdx = 0

    for (const msg of messages) {
      for (const part of msg.parts) {
        // Think tool thoughts are the richest source
        if (part.type === "tool" && part.tool === "think" && part.state.status === "completed") {
          const thought = part.state.input?.thought as string | undefined
          if (thought) {
            facts.push(...extractFromThought(thought, ++factIdx))
          }
        }

        // Text parts from assistant may contain observations
        if (part.type === "text" && msg.info.role === "assistant") {
          const text = (part as any).content ?? (part as any).text ?? ""
          if (typeof text === "string" && text.length > 20) {
            facts.push(...extractFromText(text, ++factIdx))
          }
        }

        // Read tool results contain file information
        if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
          const filePath = part.state.input?.file_path as string | undefined
          if (filePath) {
            facts.push(...extractFromReadResult(filePath, part.state.output, ++factIdx))
          }
        }

        // Edit/write tool results indicate file modification patterns
        if (
          part.type === "tool" &&
          (part.tool === "edit" || part.tool === "write") &&
          part.state.status === "completed"
        ) {
          const filePath = (part.state.input?.file_path ?? part.state.input?.filePath) as string | undefined
          if (filePath) {
            facts.push(...extractFromEdit(filePath, part.state.input, ++factIdx))
          }
        }
      }
    }

    return deduplicateFacts(facts)
  }

  // ─── Extraction Helpers ────────────────────────────────────────

  /**
   * Extract facts from a think tool thought.
   */
  function extractFromThought(thought: string, idx: number): Fact[] {
    const facts: Fact[] = []

    // File role detection
    for (const [role, markers] of Object.entries(FILE_ROLE_MARKERS)) {
      for (const marker of markers) {
        const markerIdx = thought.toLowerCase().indexOf(marker.toLowerCase())
        if (markerIdx >= 0) {
          // Look for a file path near the marker
          const context = thought.slice(Math.max(0, markerIdx - 100), markerIdx + marker.length + 100)
          const pathMatch = context.match(/(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb))/i)
          if (pathMatch) {
            facts.push({
              id: `fact-${idx}-role-${facts.length}`,
              category: "file_role",
              subject: pathMatch[1],
              content: `${pathMatch[1]} is a ${role}`,
              confidence: 0.7,
              source: "inferred",
            })
          }
        }
      }
    }

    // Code pattern detection
    for (const pattern of PATTERN_MARKERS) {
      const match = thought.match(pattern)
      if (match) {
        facts.push({
          id: `fact-${idx}-pattern-${facts.length}`,
          category: "code_pattern",
          subject: "codebase",
          content: match[0].slice(0, 200),
          confidence: 0.6,
          source: "inferred",
        })
      }
    }

    // Error-fix pattern detection
    for (const pattern of ERROR_FIX_PATTERNS) {
      const match = thought.match(pattern)
      if (match) {
        facts.push({
          id: `fact-${idx}-error-${facts.length}`,
          category: "error_pattern",
          subject: generalizeError(match[1]),
          content: `Error: "${match[1]}" → Fix: ${match[2]}`,
          confidence: 0.8,
          source: "observed",
        })
      }
    }

    // Convention detection (explicit statements)
    const conventionPattern = /(?:this (?:project|codebase|repo) (?:uses|follows|prefers|has))\s+(.+)/i
    const convMatch = thought.match(conventionPattern)
    if (convMatch) {
      facts.push({
        id: `fact-${idx}-conv-${facts.length}`,
        category: "convention",
        subject: "codebase",
        content: convMatch[1].slice(0, 200),
        confidence: 0.6,
        source: "inferred",
      })
    }

    return facts
  }

  /**
   * Extract facts from assistant text.
   */
  function extractFromText(text: string, idx: number): Fact[] {
    const facts: Fact[] = []

    // Import/dependency observations
    const depPattern = /(\S+\.(?:ts|tsx|js|jsx|py|go|rs)) (?:imports|depends on|uses|requires) (\S+)/i
    const depMatch = text.match(depPattern)
    if (depMatch) {
      facts.push({
        id: `fact-${idx}-dep-${facts.length}`,
        category: "dependency",
        subject: depMatch[1],
        content: `${depMatch[1]} depends on ${depMatch[2]}`,
        confidence: 0.7,
        source: "observed",
      })
    }

    return facts
  }

  /**
   * Extract facts from a file read result.
   */
  function extractFromReadResult(filePath: string, output: string, idx: number): Fact[] {
    const facts: Fact[] = []

    // Detect file role from content patterns
    if (output.length > 0) {
      const fileName = filePath.split("/").pop() ?? ""

      // Index files are typically entry points
      if (/^index\.(ts|tsx|js|jsx)$/.test(fileName) && output.includes("export")) {
        facts.push({
          id: `fact-${idx}-read-${facts.length}`,
          category: "file_role",
          subject: filePath,
          content: `${filePath} is a barrel/index file (re-exports)`,
          confidence: 0.5,
          source: "observed",
        })
      }

      // Config files
      if (/^(config|\.env|\w*config\w*)\./i.test(fileName)) {
        facts.push({
          id: `fact-${idx}-read-${facts.length}`,
          category: "file_role",
          subject: filePath,
          content: `${filePath} is a configuration file`,
          confidence: 0.8,
          source: "observed",
        })
      }

      // Test files
      if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(fileName) || /^test_/.test(fileName)) {
        facts.push({
          id: `fact-${idx}-read-${facts.length}`,
          category: "file_role",
          subject: filePath,
          content: `${filePath} is a test file`,
          confidence: 0.9,
          source: "observed",
        })
      }
    }

    return facts
  }

  /**
   * Extract facts from an edit operation.
   */
  function extractFromEdit(filePath: string, input: Record<string, any>, idx: number): Fact[] {
    // For now, just note that the file was modified — future: analyze the edit content
    return []
  }

  /**
   * Generalize an error message for pattern matching.
   */
  function generalizeError(error: string): string {
    return error
      .replace(/\(?\d+,\d+\)?/g, "")
      .replace(/:\d+:\d+/g, "")
      .replace(/line \d+/gi, "line N")
      .replace(/\/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs)/g, "<file>")
      .replace(/'[A-Z]\w+'/g, "'<Type>'")
      .replace(/\s+/g, " ")
      .trim()
  }

  /**
   * Deduplicate facts by subject+content similarity.
   */
  function deduplicateFacts(facts: Fact[]): Fact[] {
    const seen = new Set<string>()
    const unique: Fact[] = []

    for (const fact of facts) {
      const key = `${fact.category}:${fact.subject}:${fact.content.slice(0, 50)}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(fact)
      }
    }

    return unique
  }
}
