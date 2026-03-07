import { describe, expect, test } from "bun:test"
import path from "path"
import { ContextPipeline } from "../../src/context/pipeline"
import { GraphBuilder } from "../../src/graph/builder"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("context.pipeline", () => {
  test("extracts recent files from tool parts", () => {
    const parts = [
      { type: "tool", tool: "read", input: { file_path: "src/auth.ts" } },
      { type: "tool", tool: "edit", input: { file_path: "src/user.ts" } },
      { type: "tool", tool: "grep", input: { pattern: "TODO" } },
      { type: "text" },
      { type: "tool", tool: "write", input: { file_path: "src/new.ts" } },
    ]

    const recent = ContextPipeline.extractRecentFiles(parts as any)
    expect(recent).toContain("src/auth.ts")
    expect(recent).toContain("src/user.ts")
    expect(recent).toContain("src/new.ts")
    expect(recent).toHaveLength(3)
  })

  test("returns empty context when graph is not indexed", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "hello.ts"), `export function hello() { return "world" }`)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Don't index — graph should be empty
        const result = await ContextPipeline.run(
          "Fix the hello function",
          Instance.project.id,
          [],
        )
        expect(result.contextBlock).toBe("")
        expect(result.candidatesScored).toBe(0)
      },
    })
  })

  test(
    "returns context when graph is indexed and message references code",
    async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "service.ts"),
            `
export function processOrder(orderId: string): boolean {
  return validateOrder(orderId)
}

export function validateOrder(orderId: string): boolean {
  return orderId.length > 0
}

export class OrderService {
  process(id: string) {
    return processOrder(id)
  }
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

          const result = await ContextPipeline.run(
            "Fix the OrderService so it validates orders properly",
            projectID,
            [],
          )

          // Should find OrderService and related entities
          expect(result.candidatesScored).toBeGreaterThan(0)
          expect(result.entriesPacked).toBeGreaterThan(0)
          expect(result.contextBlock).toContain("codebase-context")
        },
      })
    },
    30_000,
  )

  test("returns empty context for messages without code references", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "app.ts"), `export function main() {}`)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        await GraphBuilder.indexProject(projectID, tmp.path)

        const result = await ContextPipeline.run(
          "hello, how are you today?",
          projectID,
          [],
        )

        // No code references in the message — should skip
        expect(result.contextBlock).toBe("")
      },
    })
  })
})
