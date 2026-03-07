import z from "zod"

/**
 * Graph node and edge type definitions for the repository knowledge graph.
 *
 * Nodes represent code entities (functions, classes, interfaces, etc.)
 * extracted from AST parsing. Edges represent relationships between
 * entities (calls, imports, extends, etc.).
 */
export namespace GraphNode {
  export const Kind = z.enum([
    "function",
    "class",
    "interface",
    "type",
    "method",
    "variable",
    "module",
    "enum",
    "import",
    "export",
  ])
  export type Kind = z.infer<typeof Kind>

  export const Info = z.object({
    id: z.string(),
    projectID: z.string(),
    filePath: z.string(),
    name: z.string(),
    kind: Kind,
    startLine: z.number().int(),
    endLine: z.number().int(),
    startCol: z.number().int(),
    endCol: z.number().int(),
    signature: z.string().optional(),
    contentHash: z.string(),
  })
  export type Info = z.infer<typeof Info>
}

export namespace GraphEdge {
  export const Kind = z.enum([
    "calls",
    "imports",
    "implements",
    "extends",
    "tested_by",
    "used_by",
    "exports",
  ])
  export type Kind = z.infer<typeof Kind>

  export const Info = z.object({
    id: z.string(),
    projectID: z.string(),
    sourceNodeID: z.string(),
    targetNodeID: z.string(),
    kind: Kind,
    filePath: z.string(),
    line: z.number().int().optional(),
  })
  export type Info = z.infer<typeof Info>
}

export namespace GraphFileState {
  export const Info = z.object({
    projectID: z.string(),
    filePath: z.string(),
    contentHash: z.string(),
    lastIndexed: z.number().int(),
    nodeCount: z.number().int(),
  })
  export type Info = z.infer<typeof Info>
}
