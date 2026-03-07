import type { Node as TSNode, Tree as TSTree } from "web-tree-sitter"
import type { GraphNode, GraphEdge } from "./node"

/**
 * Extracts code entities (nodes) and relationships (edges) from tree-sitter ASTs.
 *
 * Each language has specific AST node types that map to graph entities.
 * The extractor walks the tree, identifies entities, and captures their
 * relationships (function calls, imports, class inheritance, etc.).
 */
export namespace Extractor {
  /** Raw extracted data before IDs are assigned. */
  export interface RawNode {
    name: string
    kind: GraphNode.Kind
    startLine: number
    endLine: number
    startCol: number
    endCol: number
    signature?: string
  }

  export interface RawEdge {
    sourceNodeName: string
    targetName: string
    kind: GraphEdge.Kind
    line?: number
  }

  export interface ExtractionResult {
    nodes: RawNode[]
    edges: RawEdge[]
  }

  /**
   * Extracts nodes and edges from a parsed AST tree.
   *
   * @param tree - The tree-sitter parse tree
   * @param language - The language identifier for language-specific extraction
   * @param source - The original source text (for signature extraction)
   * @returns Extracted nodes and edges
   */
  export function extract(tree: TSTree, language: string, source: string): ExtractionResult {
    switch (language) {
      case "typescript":
      case "javascript":
        return extractTypeScript(tree, source)
      case "python":
        return extractPython(tree, source)
      case "go":
        return extractGo(tree, source)
      case "rust":
        return extractRust(tree, source)
      case "java":
        return extractJava(tree, source)
      default:
        return extractGeneric(tree, source)
    }
  }

  /**
   * Extracts the text of a named child node.
   */
  function childText(node: TSNode, fieldName: string): string | undefined {
    return node.childForFieldName(fieldName)?.text
  }

  /**
   * Gets the first line of a node's text as a signature.
   */
  function firstLine(text: string): string {
    const idx = text.indexOf("\n")
    return idx === -1 ? text : text.slice(0, idx)
  }

  /**
   * Returns the enclosing function/method/class name for a node,
   * used to attribute edges to the correct source entity.
   */
  function enclosingEntity(node: TSNode, entityTypes: string[]): string | undefined {
    let current = node.parent
    while (current) {
      if (entityTypes.includes(current.type)) {
        const name = current.childForFieldName("name")?.text
        if (name) return name
      }
      current = current.parent
    }
    return undefined
  }

  // ---------------------------------------------------------------------------
  // TypeScript / JavaScript
  // ---------------------------------------------------------------------------

  const TS_ENTITY_TYPES = [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "arrow_function",
    "generator_function_declaration",
  ]

  function extractTypeScript(tree: TSTree, source: string): ExtractionResult {
    const nodes: RawNode[] = []
    const edges: RawEdge[] = []

    function walk(node: TSNode): void {
      switch (node.type) {
        case "function_declaration":
        case "generator_function_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "function",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "class_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "class",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })

            // Check for extends
            const heritage = node.childForFieldName("superclass") ?? findChild(node, "class_heritage")
            if (heritage) {
              // class_heritage contains extends_clause, which contains the actual identifier
              const extendsClause =
                heritage.type === "class_heritage" ? findChild(heritage, "extends_clause") : undefined
              const superName = extendsClause
                ? extendsClause.namedChildren.find((c) => c?.type === "type_identifier" || c?.type === "identifier")
                    ?.text
                : heritage.text
              if (superName) {
                edges.push({
                  sourceNodeName: name,
                  targetName: superName,
                  kind: "extends",
                  line: heritage.startPosition.row + 1,
                })
              }
            }
          }
          break
        }

        case "interface_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "interface",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "type_alias_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "type",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "enum_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "enum",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "method_definition": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "method",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "lexical_declaration":
        case "variable_declaration": {
          // Capture exported const/let/var with arrow functions or significant values
          for (const decl of namedChildren(node)) {
            if (decl.type === "variable_declarator") {
              const name = childText(decl, "name")
              const value = decl.childForFieldName("value")
              if (name && value) {
                if (value.type === "arrow_function" || value.type === "function_expression") {
                  nodes.push({
                    name,
                    kind: "function",
                    startLine: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                    startCol: node.startPosition.column,
                    endCol: node.endPosition.column,
                    signature: firstLine(node.text),
                  })
                }
              }
            }
          }
          break
        }

        case "call_expression": {
          const func = node.childForFieldName("function")
          if (func) {
            const calledName = func.type === "member_expression" ? func.text : func.text
            const caller = enclosingEntity(node, TS_ENTITY_TYPES)
            if (caller && calledName) {
              edges.push({
                sourceNodeName: caller,
                targetName: calledName,
                kind: "calls",
                line: node.startPosition.row + 1,
              })
            }
          }
          break
        }

        case "import_statement": {
          const source_node = node.childForFieldName("source")
          if (source_node) {
            const importPath = source_node.text.replace(/["']/g, "")
            // Extract imported names
            const clause = findChild(node, "import_clause")
            if (clause) {
              const namedImports = findChild(clause, "named_imports")
              if (namedImports) {
                for (const spec of namedChildren(namedImports)) {
                  const importedName = spec.childForFieldName("name")?.text ?? spec.text
                  if (importedName) {
                    edges.push({
                      sourceNodeName: importedName,
                      targetName: importPath,
                      kind: "imports",
                      line: node.startPosition.row + 1,
                    })
                  }
                }
              }
            }
          }
          break
        }

        case "export_statement": {
          const declaration = node.childForFieldName("declaration")
          if (declaration) {
            const name =
              declaration.childForFieldName("name")?.text ??
              namedChildren(declaration).find((c) => c.type === "variable_declarator")?.childForFieldName("name")?.text
            if (name) {
              edges.push({
                sourceNodeName: name,
                targetName: name,
                kind: "exports",
                line: node.startPosition.row + 1,
              })
            }
          }
          break
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) walk(child)
      }
    }

    walk(tree.rootNode)
    return { nodes, edges }
  }

  // ---------------------------------------------------------------------------
  // Python
  // ---------------------------------------------------------------------------

  const PY_ENTITY_TYPES = ["function_definition", "class_definition"]

  function extractPython(tree: TSTree, source: string): ExtractionResult {
    const nodes: RawNode[] = []
    const edges: RawEdge[] = []

    function walk(node: TSNode): void {
      switch (node.type) {
        case "function_definition": {
          const name = childText(node, "name")
          if (name) {
            const params = node.childForFieldName("parameters")?.text ?? ""
            const returnType = node.childForFieldName("return_type")?.text
            nodes.push({
              name,
              kind: "function",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: `def ${name}${params}${returnType ? ` -> ${returnType}` : ""}`,
            })
          }
          break
        }

        case "class_definition": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "class",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })

            // Check superclasses
            const argList = node.childForFieldName("superclasses")
            if (argList) {
              for (const arg of namedChildren(argList)) {
                if (arg.type === "identifier" || arg.type === "attribute") {
                  edges.push({
                    sourceNodeName: name,
                    targetName: arg.text,
                    kind: "extends",
                    line: arg.startPosition.row + 1,
                  })
                }
              }
            }
          }
          break
        }

        case "call": {
          const func = node.childForFieldName("function")
          if (func) {
            const caller = enclosingEntity(node, PY_ENTITY_TYPES)
            if (caller) {
              edges.push({
                sourceNodeName: caller,
                targetName: func.text,
                kind: "calls",
                line: node.startPosition.row + 1,
              })
            }
          }
          break
        }

        case "import_statement":
        case "import_from_statement": {
          const moduleName = node.childForFieldName("module_name")?.text ?? childText(node, "name")
          if (moduleName) {
            // For "from X import Y", capture Y as importing from X
            const names = namedChildren(node).filter((c) => c.type === "dotted_name" || c.type === "aliased_import")
            if (names.length > 0) {
              for (const n of names) {
                const importedName = n.childForFieldName("name")?.text ?? n.text
                if (importedName && importedName !== moduleName) {
                  edges.push({
                    sourceNodeName: importedName,
                    targetName: moduleName,
                    kind: "imports",
                    line: node.startPosition.row + 1,
                  })
                }
              }
            }
          }
          break
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) walk(child)
      }
    }

    walk(tree.rootNode)
    return { nodes, edges }
  }

  // ---------------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------------

  const GO_ENTITY_TYPES = ["function_declaration", "method_declaration"]

  function extractGo(tree: TSTree, source: string): ExtractionResult {
    const nodes: RawNode[] = []
    const edges: RawEdge[] = []

    function walk(node: TSNode): void {
      switch (node.type) {
        case "function_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "function",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "method_declaration": {
          const name = childText(node, "name")
          if (name) {
            const receiver = node.childForFieldName("receiver")?.text ?? ""
            nodes.push({
              name,
              kind: "method",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "type_declaration": {
          for (const spec of namedChildren(node)) {
            if (spec.type === "type_spec") {
              const name = childText(spec, "name")
              const typeNode = spec.childForFieldName("type")
              if (name && typeNode) {
                const kind: GraphNode.Kind =
                  typeNode.type === "struct_type"
                    ? "class"
                    : typeNode.type === "interface_type"
                      ? "interface"
                      : "type"
                nodes.push({
                  name,
                  kind,
                  startLine: spec.startPosition.row + 1,
                  endLine: spec.endPosition.row + 1,
                  startCol: spec.startPosition.column,
                  endCol: spec.endPosition.column,
                  signature: firstLine(spec.text),
                })
              }
            }
          }
          break
        }

        case "call_expression": {
          const func = node.childForFieldName("function")
          if (func) {
            const caller = enclosingEntity(node, GO_ENTITY_TYPES)
            if (caller) {
              edges.push({
                sourceNodeName: caller,
                targetName: func.text,
                kind: "calls",
                line: node.startPosition.row + 1,
              })
            }
          }
          break
        }

        case "import_declaration": {
          for (const spec of namedChildren(node)) {
            if (spec.type === "import_spec" || spec.type === "interpreted_string_literal") {
              const importPath = spec.text.replace(/"/g, "")
              edges.push({
                sourceNodeName: "_module",
                targetName: importPath,
                kind: "imports",
                line: spec.startPosition.row + 1,
              })
            }
          }
          break
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) walk(child)
      }
    }

    walk(tree.rootNode)
    return { nodes, edges }
  }

  // ---------------------------------------------------------------------------
  // Rust
  // ---------------------------------------------------------------------------

  const RUST_ENTITY_TYPES = ["function_item", "impl_item"]

  function extractRust(tree: TSTree, source: string): ExtractionResult {
    const nodes: RawNode[] = []
    const edges: RawEdge[] = []

    function walk(node: TSNode): void {
      switch (node.type) {
        case "function_item": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "function",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "struct_item": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "class",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "trait_item": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "interface",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "enum_item": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "enum",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "impl_item": {
          const trait_node = node.childForFieldName("trait")
          const type_node = node.childForFieldName("type")
          if (trait_node && type_node) {
            edges.push({
              sourceNodeName: type_node.text,
              targetName: trait_node.text,
              kind: "implements",
              line: node.startPosition.row + 1,
            })
          }
          break
        }

        case "call_expression": {
          const func = node.childForFieldName("function")
          if (func) {
            const caller = enclosingEntity(node, RUST_ENTITY_TYPES)
            if (caller) {
              edges.push({
                sourceNodeName: caller,
                targetName: func.text,
                kind: "calls",
                line: node.startPosition.row + 1,
              })
            }
          }
          break
        }

        case "use_declaration": {
          const arg = namedChildren(node)[0]
          if (arg) {
            edges.push({
              sourceNodeName: "_module",
              targetName: arg.text,
              kind: "imports",
              line: node.startPosition.row + 1,
            })
          }
          break
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) walk(child)
      }
    }

    walk(tree.rootNode)
    return { nodes, edges }
  }

  // ---------------------------------------------------------------------------
  // Java
  // ---------------------------------------------------------------------------

  const JAVA_ENTITY_TYPES = ["method_declaration", "constructor_declaration"]

  function extractJava(tree: TSTree, source: string): ExtractionResult {
    const nodes: RawNode[] = []
    const edges: RawEdge[] = []

    function walk(node: TSNode): void {
      switch (node.type) {
        case "method_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "method",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "class_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "class",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })

            const superclass = node.childForFieldName("superclass")
            if (superclass) {
              edges.push({
                sourceNodeName: name,
                targetName: superclass.text,
                kind: "extends",
                line: superclass.startPosition.row + 1,
              })
            }

            const interfaces = node.childForFieldName("interfaces")
            if (interfaces) {
              for (const iface of namedChildren(interfaces)) {
                edges.push({
                  sourceNodeName: name,
                  targetName: iface.text,
                  kind: "implements",
                  line: iface.startPosition.row + 1,
                })
              }
            }
          }
          break
        }

        case "interface_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "interface",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "enum_declaration": {
          const name = childText(node, "name")
          if (name) {
            nodes.push({
              name,
              kind: "enum",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              signature: firstLine(node.text),
            })
          }
          break
        }

        case "method_invocation": {
          const name = childText(node, "name")
          if (name) {
            const caller = enclosingEntity(node, JAVA_ENTITY_TYPES)
            if (caller) {
              const obj = node.childForFieldName("object")
              const target = obj ? `${obj.text}.${name}` : name
              edges.push({
                sourceNodeName: caller,
                targetName: target,
                kind: "calls",
                line: node.startPosition.row + 1,
              })
            }
          }
          break
        }

        case "import_declaration": {
          const importPath = namedChildren(node).map((c) => c.text).join("")
          if (importPath) {
            edges.push({
              sourceNodeName: "_module",
              targetName: importPath,
              kind: "imports",
              line: node.startPosition.row + 1,
            })
          }
          break
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) walk(child)
      }
    }

    walk(tree.rootNode)
    return { nodes, edges }
  }

  // ---------------------------------------------------------------------------
  // Generic fallback — extracts basic entities from any language
  // ---------------------------------------------------------------------------

  function extractGeneric(tree: TSTree, source: string): ExtractionResult {
    const nodes: RawNode[] = []
    const edges: RawEdge[] = []

    function walk(node: TSNode): void {
      // Common patterns across languages
      if (node.type.includes("function") && node.type.includes("declaration")) {
        const name = childText(node, "name")
        if (name) {
          nodes.push({
            name,
            kind: "function",
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            startCol: node.startPosition.column,
            endCol: node.endPosition.column,
            signature: firstLine(node.text),
          })
        }
      } else if (node.type.includes("class") && node.type.includes("declaration")) {
        const name = childText(node, "name")
        if (name) {
          nodes.push({
            name,
            kind: "class",
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            startCol: node.startPosition.column,
            endCol: node.endPosition.column,
            signature: firstLine(node.text),
          })
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) walk(child)
      }
    }

    walk(tree.rootNode)
    return { nodes, edges }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns non-null named children of a node.
   */
  function namedChildren(node: TSNode): TSNode[] {
    return node.namedChildren.filter((c): c is TSNode => c != null)
  }

  /**
   * Finds the first child node matching a given type.
   */
  function findChild(node: TSNode, type: string): TSNode | undefined {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === type) return child
    }
    return undefined
  }
}
