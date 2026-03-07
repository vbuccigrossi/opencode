import z from "zod"
import { Tool } from "./tool"
import { Graph } from "../graph"
import { GitMetadata } from "../graph/git-metadata"
import { Instance } from "../project/instance"

/**
 * Exposes the repository knowledge graph to the agent as a tool.
 *
 * Allows structural code navigation: finding symbols, tracing call graphs,
 * analyzing imports, computing change impact, and understanding architecture.
 */
export const GraphTool = Tool.define("graph", async () => ({
  description: `Query the repository knowledge graph for structural code navigation. This tool understands code entities (functions, classes, interfaces) and their relationships (calls, imports, extends, implements).

Operations:
- find_symbol: Find a function, class, interface, or type by name
- callers_of: Find all functions/methods that call a given symbol
- callees_of: Find all symbols called by a given function/method
- impact_of: Analyze the impact of changing a symbol (dependents, tests, files)
- architecture: Get a high-level summary of the project's module structure
- related_tests: Find tests related to a given symbol
- nodes_in_file: List all code entities in a specific file
- stats: Get graph statistics (node count, edge count, languages)
- hotspots: Find files with the most changes in recent git history (volatile code areas)
- recently_changed: Find code entities (functions, classes) that are actively being modified

Use this tool BEFORE making edits to understand the codebase structure, find all call sites, and assess change impact. This is much faster and more reliable than searching with grep for understanding code relationships.`,
  parameters: z.object({
    operation: z
      .enum([
        "find_symbol",
        "callers_of",
        "callees_of",
        "impact_of",
        "architecture",
        "related_tests",
        "nodes_in_file",
        "stats",
        "hotspots",
        "recently_changed",
      ])
      .describe("The graph query operation to perform"),
    symbol: z
      .string()
      .optional()
      .describe("Symbol name to query (required for find_symbol, callers_of, callees_of, impact_of, related_tests)"),
    kind: z
      .enum(["function", "class", "interface", "type", "method", "variable", "module", "enum", "import", "export"])
      .optional()
      .describe("Filter by entity kind (optional, for find_symbol)"),
    file: z.string().optional().describe("File path (required for nodes_in_file, relative to project root)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    const projectID = Instance.project.id

    switch (params.operation) {
      case "find_symbol": {
        if (!params.symbol) throw new Error("symbol parameter is required for find_symbol")
        const results = Graph.findSymbol(projectID, params.symbol, params.kind as any)
        if (results.length === 0) {
          return {
            title: `find_symbol: ${params.symbol}`,
            metadata: { count: 0 },
            output: `No symbols found matching "${params.symbol}"${params.kind ? ` of kind "${params.kind}"` : ""}`,
          }
        }
        const output = results
          .map((r) => `${r.kind} ${r.name} at ${r.filePath}:${r.startLine}${r.signature ? `\n  ${r.signature}` : ""}`)
          .join("\n\n")
        return {
          title: `find_symbol: ${params.symbol}`,
          metadata: { count: results.length },
          output: `Found ${results.length} symbol(s):\n\n${output}`,
        }
      }

      case "callers_of": {
        if (!params.symbol) throw new Error("symbol parameter is required for callers_of")
        const results = Graph.callersOf(projectID, params.symbol)
        if (results.length === 0) {
          return {
            title: `callers_of: ${params.symbol}`,
            metadata: { count: 0 },
            output: `No callers found for "${params.symbol}"`,
          }
        }
        const output = results
          .map((r) => `${r.kind} ${r.name} at ${r.filePath}:${r.startLine}`)
          .join("\n")
        return {
          title: `callers_of: ${params.symbol}`,
          metadata: { count: results.length },
          output: `${results.length} caller(s) of "${params.symbol}":\n\n${output}`,
        }
      }

      case "callees_of": {
        if (!params.symbol) throw new Error("symbol parameter is required for callees_of")
        const results = Graph.calleesOf(projectID, params.symbol)
        if (results.length === 0) {
          return {
            title: `callees_of: ${params.symbol}`,
            metadata: { count: 0 },
            output: `No callees found for "${params.symbol}"`,
          }
        }
        const output = results
          .map((r) => `${r.kind} ${r.name} at ${r.filePath}:${r.startLine}`)
          .join("\n")
        return {
          title: `callees_of: ${params.symbol}`,
          metadata: { count: results.length },
          output: `${results.length} callee(s) of "${params.symbol}":\n\n${output}`,
        }
      }

      case "impact_of": {
        if (!params.symbol) throw new Error("symbol parameter is required for impact_of")
        const result = Graph.impactOf(projectID, params.symbol)
        const sections: string[] = []

        if (result.directDependents.length > 0) {
          sections.push(
            `Direct dependents (${result.directDependents.length}):\n` +
              result.directDependents.map((r) => `  ${r.kind} ${r.name} at ${r.filePath}:${r.startLine}`).join("\n"),
          )
        }

        if (result.transitiveDependents.length > 0) {
          sections.push(
            `Transitive dependents (${result.transitiveDependents.length}):\n` +
              result.transitiveDependents
                .map((r) => `  ${r.kind} ${r.name} at ${r.filePath}:${r.startLine}`)
                .join("\n"),
          )
        }

        if (result.affectedTests.length > 0) {
          sections.push(
            `Affected tests (${result.affectedTests.length}):\n` +
              result.affectedTests.map((r) => `  ${r.name} at ${r.filePath}:${r.startLine}`).join("\n"),
          )
        }

        if (result.affectedFiles.length > 0) {
          sections.push(`Affected files (${result.affectedFiles.length}):\n` + result.affectedFiles.map((f) => `  ${f}`).join("\n"))
        }

        const output =
          sections.length > 0
            ? `Impact analysis for "${params.symbol}":\n\n${sections.join("\n\n")}`
            : `No impact detected for "${params.symbol}" — symbol may not exist in the graph or has no dependents.`

        return {
          title: `impact_of: ${params.symbol}`,
          metadata: {
            count: result.directDependents.length + result.transitiveDependents.length,
            directCount: result.directDependents.length,
            transitiveCount: result.transitiveDependents.length,
            testCount: result.affectedTests.length,
            fileCount: result.affectedFiles.length,
          },
          output,
        }
      }

      case "architecture": {
        const result = Graph.architecture(projectID)
        if (result.files.length === 0) {
          return {
            title: "architecture",
            metadata: { count: 0, totalNodes: 0, totalEdges: 0 },
            output:
              "No graph data available. The repository may not have been indexed yet. Graph indexing runs automatically on project start.",
          }
        }
        const fileLines = result.files
          .slice(0, 50)
          .map((f) => {
            const parts: string[] = []
            if (f.functions > 0) parts.push(`${f.functions} functions`)
            if (f.classes > 0) parts.push(`${f.classes} classes`)
            if (f.interfaces > 0) parts.push(`${f.interfaces} interfaces`)
            if (f.types > 0) parts.push(`${f.types} types`)
            return `${f.path}: ${parts.join(", ")}`
          })
          .join("\n")

        const output = [
          `Project architecture summary:`,
          `Total nodes: ${result.totalNodes}`,
          `Total edges: ${result.totalEdges}`,
          `Files with code entities (top 50):`,
          ``,
          fileLines,
        ].join("\n")

        return {
          title: "architecture",
          metadata: { count: result.files.length, totalNodes: result.totalNodes, totalEdges: result.totalEdges },
          output,
        }
      }

      case "related_tests": {
        if (!params.symbol) throw new Error("symbol parameter is required for related_tests")
        const results = Graph.relatedTests(projectID, params.symbol)
        if (results.length === 0) {
          return {
            title: `related_tests: ${params.symbol}`,
            metadata: { count: 0 },
            output: `No test files found related to "${params.symbol}"`,
          }
        }
        const output = results
          .map((r) => `${r.name} at ${r.filePath}:${r.startLine}`)
          .join("\n")
        return {
          title: `related_tests: ${params.symbol}`,
          metadata: { count: results.length },
          output: `${results.length} test(s) related to "${params.symbol}":\n\n${output}`,
        }
      }

      case "nodes_in_file": {
        if (!params.file) throw new Error("file parameter is required for nodes_in_file")
        const results = Graph.nodesInFile(projectID, params.file)
        if (results.length === 0) {
          return {
            title: `nodes_in_file: ${params.file}`,
            metadata: { count: 0 },
            output: `No code entities found in "${params.file}". File may not be indexed or may not contain supported entity types.`,
          }
        }
        const output = results
          .map(
            (r) =>
              `L${r.startLine}-${r.endLine} ${r.kind} ${r.name}${r.signature ? `\n  ${r.signature}` : ""}`,
          )
          .join("\n\n")
        return {
          title: `nodes_in_file: ${params.file}`,
          metadata: { count: results.length },
          output: `${results.length} entity(ies) in ${params.file}:\n\n${output}`,
        }
      }

      case "stats": {
        const result = Graph.stats(projectID)
        return {
          title: "graph stats",
          metadata: { count: result.nodeCount, ...result },
          output: [
            `Graph statistics:`,
            `  Nodes: ${result.nodeCount}`,
            `  Edges: ${result.edgeCount}`,
            `  Indexed files: ${result.fileCount}`,
            `  Languages: ${result.languages.join(", ") || "none"}`,
          ].join("\n"),
        }
      }

      case "hotspots": {
        const results = await GitMetadata.hotspots(Instance.worktree)
        if (results.length === 0) {
          return {
            title: "hotspots",
            metadata: { count: 0 },
            output: "No git history found or no file changes in the last 180 days.",
          }
        }
        const output = results
          .map(
            (r) =>
              `${r.filePath}: ${r.changeCount} changes, ${r.contributors} contributor(s), last modified ${new Date(r.lastModified).toLocaleDateString()}`,
          )
          .join("\n")
        return {
          title: "hotspots",
          metadata: { count: results.length },
          output: `Top ${results.length} most-changed files:\n\n${output}`,
        }
      }

      case "recently_changed": {
        const results = await GitMetadata.recentlyChangedEntities(projectID, Instance.worktree)
        if (results.length === 0) {
          return {
            title: "recently_changed",
            metadata: { count: 0 },
            output: "No recently changed code entities found. The graph may not be indexed yet.",
          }
        }
        const output = results
          .map(
            (r) =>
              `${r.kind} ${r.name} in ${r.filePath} (${r.changeCount} changes, last ${new Date(r.lastModified).toLocaleDateString()})`,
          )
          .join("\n")
        return {
          title: "recently_changed",
          metadata: { count: results.length },
          output: `${results.length} recently changed entity(ies):\n\n${output}`,
        }
      }

      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))
