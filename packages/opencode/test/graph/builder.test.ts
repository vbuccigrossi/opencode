import { describe, expect, test } from "bun:test"
import path from "path"
import { GraphBuilder } from "../../src/graph/builder"
import { Graph } from "../../src/graph"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("graph.builder", () => {
  test(
    "indexes a single typescript file",
    async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "service.ts"),
          `
export interface Logger {
  log(message: string): void
}

export class ConsoleLogger implements Logger {
  log(message: string): void {
    console.log(message)
  }
}

export function createLogger(): Logger {
  return new ConsoleLogger()
}

function helper() {
  return "internal"
}
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        const count = await GraphBuilder.indexFile(path.join(tmp.path, "service.ts"), projectID)

        expect(count).toBeGreaterThan(0)

        // Check nodes were stored
        const nodes = Graph.nodesInFile(projectID, "service.ts")
        const nodeNames = nodes.map((n) => n.name)
        expect(nodeNames).toContain("Logger")
        expect(nodeNames).toContain("ConsoleLogger")
        expect(nodeNames).toContain("createLogger")
        expect(nodeNames).toContain("helper")

        // Check node kinds
        const logger = nodes.find((n) => n.name === "Logger")
        expect(logger?.kind).toBe("interface")

        const consoleLogger = nodes.find((n) => n.name === "ConsoleLogger")
        expect(consoleLogger?.kind).toBe("class")

        const createFn = nodes.find((n) => n.name === "createLogger")
        expect(createFn?.kind).toBe("function")
      },
    })
    },
    30_000,
  )

  test("skips file when content hash unchanged", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "stable.ts"), `export const x = 1`)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        const filePath = path.join(tmp.path, "stable.ts")

        // First index
        const first = await GraphBuilder.indexFile(filePath, projectID)
        expect(first).toBeGreaterThanOrEqual(0)

        // Second index should skip (returns -1)
        const second = await GraphBuilder.indexFile(filePath, projectID)
        expect(second).toBe(-1)
      },
    })
  })

  test("re-indexes when content changes", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "changing.ts"), `export function a() { return 1 }`)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        const filePath = path.join(tmp.path, "changing.ts")

        await GraphBuilder.indexFile(filePath, projectID)
        let nodes = Graph.nodesInFile(projectID, "changing.ts")
        expect(nodes.map((n) => n.name)).toContain("a")

        // Change the file content
        await Bun.write(filePath, `export function b() { return 2 }`)

        const count = await GraphBuilder.indexFile(filePath, projectID)
        expect(count).toBeGreaterThan(0)

        nodes = Graph.nodesInFile(projectID, "changing.ts")
        expect(nodes.map((n) => n.name)).toContain("b")
        expect(nodes.map((n) => n.name)).not.toContain("a")
      },
    })
  })

  test("handles deleted file gracefully", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "ephemeral.ts"), `export function temp() {}`)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        const filePath = path.join(tmp.path, "ephemeral.ts")

        await GraphBuilder.indexFile(filePath, projectID)

        // Delete the file
        const fs = await import("fs/promises")
        await fs.unlink(filePath)

        // Should not throw, should clean up
        const count = await GraphBuilder.indexFile(filePath, projectID)
        expect(count).toBe(0)
      },
    })
  })

  test("indexes multiple files in a project", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "model.ts"),
          `
export interface User {
  id: string
  name: string
}

export function createUser(name: string): User {
  return { id: "1", name }
}
`,
        )
        await Bun.write(
          path.join(dir, "service.ts"),
          `
import { User, createUser } from "./model"

export class UserService {
  getUser(name: string): User {
    return createUser(name)
  }
}
`,
        )
        await Bun.write(path.join(dir, "readme.md"), `# Not indexed`)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        const result = await GraphBuilder.indexProject(projectID, tmp.path)

        // Should index .ts files but not .md
        expect(result.indexed).toBe(2)
        expect(result.total).toBe(2)
        expect(result.errors).toBe(0)

        // Check stats
        const stats = Graph.stats(projectID)
        expect(stats.nodeCount).toBeGreaterThan(0)
        expect(stats.fileCount).toBe(2)
      },
    })
  })
})

describe("graph.queries", () => {
  test("findSymbol locates nodes by name", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "api.ts"),
          `
export function fetchData() { return [] }
export function fetchUser() { return {} }
export class DataStore {}
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        await GraphBuilder.indexProject(projectID, tmp.path)

        const results = Graph.findSymbol(projectID, "fetchData")
        expect(results.length).toBe(1)
        expect(results[0].kind).toBe("function")

        const classes = Graph.findSymbol(projectID, "DataStore", "class")
        expect(classes.length).toBe(1)
      },
    })
  })

  test("architecture returns project summary", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "a.ts"),
          `
export function f1() {}
export function f2() {}
export class C1 {}
`,
        )
        await Bun.write(path.join(dir, "b.ts"), `export interface I1 {}`)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        await GraphBuilder.indexProject(projectID, tmp.path)

        const arch = Graph.architecture(projectID)
        expect(arch.totalNodes).toBeGreaterThan(0)
        expect(arch.files.length).toBe(2)
      },
    })
  })

  test("impactOf traces dependents", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "core.ts"),
          `
export function validate(input: string): boolean {
  return input.length > 0
}

export function process(data: string) {
  if (validate(data)) {
    return data.toUpperCase()
  }
  return ""
}

export function handleRequest(req: string) {
  return process(req)
}
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        await GraphBuilder.indexProject(projectID, tmp.path)

        // process calls validate, handleRequest calls process
        const impact = Graph.impactOf(projectID, "validate")
        const directNames = impact.directDependents.map((n) => n.name)
        expect(directNames).toContain("process")
      },
    })
  })

  test("clear removes all graph data", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "temp.ts"), `export function temp() {}`)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        await GraphBuilder.indexProject(projectID, tmp.path)

        let stats = Graph.stats(projectID)
        expect(stats.nodeCount).toBeGreaterThan(0)

        Graph.clear(projectID)

        stats = Graph.stats(projectID)
        expect(stats.nodeCount).toBe(0)
        expect(stats.edgeCount).toBe(0)
      },
    })
  })
})
