import { Log } from "@/util/log"
import { RAG } from "./rag"
import { RAGFormatter } from "./format"
import { Token } from "@/util/token"

/**
 * Step-aware RAG retrieval — dynamically search RAG based on tool calls
 * to provide relevant context as the model works through a problem.
 *
 * Triggers on:
 *   - think: extracts key concepts from reasoning to find related docs
 *   - read: uses file content/path to find related API docs and examples
 *   - edit/write: extracts imports, function calls, and patterns to find docs
 *   - grep/glob: uses search patterns to find related documentation
 *
 * Unlike error-rag (one-shot), step-rag accumulates and refreshes context
 * across the session, replacing stale results with more relevant ones.
 */
export namespace StepRAG {
  const log = Log.create({ service: "embedding.step-rag" })

  /** Cached step-aware RAG context per session. */
  const cache = new Map<string, string>()

  /** Track queries we've already run to avoid duplicates. */
  const queryHistory = new Map<string, Set<string>>()

  /**
   * Process tool results from a completed step and search RAG for
   * relevant context to inject into the next step.
   */
  export async function processToolResults(
    sessionID: string,
    parts: Array<{ type: string; tool?: string; state?: any }>,
    maxTokens: number = 2000,
  ): Promise<void> {
    const configured = await RAG.isConfigured()
    if (!configured) return

    const queries: string[] = []
    const history = queryHistory.get(sessionID) ?? new Set()

    for (const part of parts) {
      if (part.type !== "tool") continue
      const state = part.state
      if (!state || (state.status !== "completed" && state.status !== "error")) continue

      const input = state.input ?? {}
      const output = state.output ?? ""

      switch (part.tool) {
        case "think": {
          // Extract key concepts from the model's reasoning
          const thought = input.thought ?? input.content ?? ""
          if (thought.length < 20) break
          const thinkQueries = extractThinkQueries(thought)
          for (const q of thinkQueries) {
            if (!history.has(q)) queries.push(q)
          }
          break
        }

        case "read": {
          // Use file path and content to find related docs
          const filePath = input.filePath ?? input.file_path ?? ""
          const content = output.slice(0, 2000)
          const readQueries = extractReadQueries(filePath, content)
          for (const q of readQueries) {
            if (!history.has(q)) queries.push(q)
          }
          break
        }

        case "edit":
        case "write": {
          // Extract imports and API usage from code being written
          const content = input.content ?? input.newString ?? input.new_string ?? ""
          const filePath = input.filePath ?? input.file_path ?? ""
          const codeQueries = extractCodeQueries(filePath, content)
          for (const q of codeQueries) {
            if (!history.has(q)) queries.push(q)
          }
          break
        }

        case "grep":
        case "glob": {
          // Use search patterns as potential RAG queries
          const pattern = input.pattern ?? ""
          if (pattern.length > 3 && !history.has(pattern)) {
            queries.push(pattern)
          }
          break
        }

        case "bash": {
          // Extract useful context from successful bash commands
          // (errors are handled by error-rag)
          if (state.status === "completed" && output.length > 0) {
            const bashQueries = extractBashQueries(input.command ?? "", output)
            for (const q of bashQueries) {
              if (!history.has(q)) queries.push(q)
            }
          }
          break
        }
      }
    }

    if (queries.length === 0) return

    // Deduplicate and limit to 3 queries per step
    const uniqueQueries = [...new Set(queries)].slice(0, 3)

    try {
      const allResults: RAG.SearchResult[] = []
      const seenChunks = new Set<string>()

      for (const query of uniqueQueries) {
        history.add(query)
        const results = await RAG.search(query, 8, 0.3)
        for (const r of results) {
          if (!seenChunks.has(r.chunkID)) {
            seenChunks.add(r.chunkID)
            allResults.push(r)
          }
        }
      }

      queryHistory.set(sessionID, history)

      if (allResults.length === 0) {
        log.info("no step-RAG results", { queries: uniqueQueries })
        return
      }

      // Sort by similarity, format within budget
      allResults.sort((a, b) => b.similarity - a.similarity)
      const formatted = RAGFormatter.formatResults(allResults, maxTokens - 100)

      if (!formatted) return

      const block = [
        "<step-context>",
        "Relevant documentation and examples based on your current work:",
        "",
        formatted,
        "</step-context>",
      ].join("\n")

      const tokenCount = Token.estimate(block)
      cache.set(sessionID, block)
      log.info("step-RAG context cached", {
        sessionID,
        queries: uniqueQueries,
        results: allResults.length,
        tokens: tokenCount,
      })
    } catch (err: any) {
      log.warn("step-RAG search failed", { error: err.message })
    }
  }

  /** Get cached step context for injection. */
  export function getInjection(sessionID: string): string | undefined {
    return cache.get(sessionID)
  }

  /** Clear step context (called after injection to avoid stale data). */
  export function clearInjection(sessionID: string): void {
    cache.delete(sessionID)
  }

  /** Full cleanup for session end. */
  export function clear(sessionID: string): void {
    cache.delete(sessionID)
    queryHistory.delete(sessionID)
  }

  // ── Query extraction helpers ──

  /**
   * Extract search queries from the model's think tool reasoning.
   * Looks for references to packages, frameworks, APIs, CVEs, and techniques.
   */
  function extractThinkQueries(thought: string): string[] {
    const queries: string[] = []

    // Extract Go package references (e.g., "go-exploit", "config", "c2")
    const goPackages = thought.matchAll(/\b(?:go-exploit|vulncheck)[\/\.](\w+)/gi)
    for (const m of goPackages) {
      queries.push(`go-exploit ${m[1]} API documentation`)
    }

    // Extract CVE references
    const cves = thought.matchAll(/CVE-\d{4}-\d{4,}/gi)
    for (const m of cves) {
      queries.push(`${m[0]} vulnerability exploit`)
    }

    // Extract "how to" / "need to" patterns — the model is expressing intent
    const intentPatterns = thought.matchAll(/(?:need to|should|want to|have to|going to|will)\s+(.{10,60}?)(?:\.|,|$)/gi)
    for (const m of intentPatterns) {
      const intent = m[1].trim()
      if (intent.length > 10) {
        queries.push(intent)
      }
    }

    // Extract framework/library references
    const frameworks = thought.matchAll(/\b(exploit|payload|reverse.shell|bind.shell|c2|command.and.control|suricata|snort|detection)\b/gi)
    const frameworkSet = new Set<string>()
    for (const m of frameworks) {
      frameworkSet.add(m[1].toLowerCase())
    }
    if (frameworkSet.size > 0) {
      queries.push([...frameworkSet].slice(0, 3).join(" ") + " implementation example")
    }

    return queries.slice(0, 2)
  }

  /**
   * Extract queries from a file read — use the file path and content
   * to find related API docs and examples.
   */
  function extractReadQueries(filePath: string, content: string): string[] {
    const queries: string[] = []

    // If reading a Go file, extract imports for documentation lookup
    if (filePath.endsWith(".go")) {
      const imports = content.matchAll(/import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g)
      for (const m of imports) {
        const block = m[1] || m[2] || ""
        const pkgMatches = block.matchAll(/"([^"]+)"/g)
        for (const pm of pkgMatches) {
          const pkg = pm[1]
          // Only search for non-stdlib, interesting packages
          if (pkg.includes("go-exploit") || pkg.includes("vulncheck")) {
            const shortName = pkg.split("/").pop() ?? pkg
            queries.push(`go-exploit ${shortName} API usage`)
          }
        }
      }

      // Extract function signatures being called that might need docs
      const funcCalls = content.matchAll(/(?:exploit|config|c2|output|payload)\.\w+/g)
      const callSet = new Set<string>()
      for (const m of funcCalls) {
        callSet.add(m[0])
      }
      if (callSet.size > 0) {
        queries.push([...callSet].slice(0, 4).join(" ") + " documentation")
      }
    }

    // If reading a rule file, look for related detection docs
    if (filePath.endsWith(".rule") || filePath.endsWith(".rules")) {
      queries.push("snort suricata rule syntax detection")
    }

    return queries.slice(0, 2)
  }

  /**
   * Extract queries from code being written/edited.
   * Finds imports, API calls, and patterns to look up.
   */
  function extractCodeQueries(filePath: string, content: string): string[] {
    const queries: string[] = []

    if (!content) return queries

    // Go imports
    const imports = content.matchAll(/"([^"]*(?:go-exploit|vulncheck)[^"]*)"/g)
    for (const m of imports) {
      const shortName = m[1].split("/").pop() ?? m[1]
      queries.push(`go-exploit ${shortName} API functions types`)
    }

    // Go struct/interface implementations
    const structs = content.matchAll(/func\s+\([^)]+\)\s+(\w+)\s*\(/g)
    const methods = new Set<string>()
    for (const m of structs) {
      methods.add(m[1])
    }
    if (methods.size > 0) {
      // If implementing exploit interface methods, get the template
      const exploitMethods = ["ValidateTarget", "CheckVersion", "RunExploit"]
      const isExploit = [...methods].some(m => exploitMethods.includes(m))
      if (isExploit) {
        queries.push("go-exploit template RunExploit ValidateTarget CheckVersion example")
      }
    }

    // Snort/Suricata rule patterns
    if (filePath.endsWith(".rule") || content.includes("alert ") && content.includes("sid:")) {
      queries.push("snort suricata rule syntax content pcre flowbits")
    }

    // YARA rule patterns
    if (content.includes("rule ") && content.includes("condition:")) {
      queries.push("yara rule syntax strings condition")
    }

    return queries.slice(0, 2)
  }

  /**
   * Extract useful queries from successful bash commands.
   * Looks for go build, go run, and other development commands.
   */
  function extractBashQueries(command: string, output: string): string[] {
    const queries: string[] = []

    // If running "go mod tidy" or "go get", the user is setting up dependencies
    if (/go\s+(mod|get)\s/i.test(command)) {
      // Extract package names from go get commands
      const getPkg = command.match(/go\s+get\s+(\S+)/i)
      if (getPkg) {
        const shortName = getPkg[1].split("/").pop() ?? getPkg[1]
        queries.push(`${shortName} API documentation usage examples`)
      }
    }

    // If running the exploit, look for related technique docs
    if (/go\s+run\s/i.test(command) && output.includes("exploit")) {
      queries.push("go-exploit usage running scanning exploitation")
    }

    return queries.slice(0, 1)
  }
}
