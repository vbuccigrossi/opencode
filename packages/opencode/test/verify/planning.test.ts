import { describe, expect, test } from "bun:test"
import path from "path"
import { EditPlanning } from "../../src/agent/planning"
import { GraphBuilder } from "../../src/graph/builder"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("agent.planning", () => {
  test(
    "analyzes impact of editing a symbol",
    async () => {
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

          const impact = EditPlanning.analyzeImpact(["validate"], [])

          // process calls validate
          expect(impact.directCallers.length).toBeGreaterThan(0)
          const callerNames = impact.directCallers.map((c) => c.name)
          expect(callerNames).toContain("process")
          expect(impact.targetSymbols).toContain("validate")
        },
      })
    },
    30_000,
  )

  test("formats impact analysis", () => {
    const impact: EditPlanning.EditImpact = {
      targetSymbols: ["processOrder"],
      directCallers: [
        { name: "handleRequest", kind: "function", filePath: "src/api.ts", line: 15 },
        { name: "runBatch", kind: "function", filePath: "src/batch.ts", line: 42 },
      ],
      affectedFiles: ["src/api.ts", "src/batch.ts"],
      affectedTests: [
        { name: "test_order_processing", filePath: "test/orders.test.ts", line: 10 },
      ],
      verifyCommands: { typecheck: "bun tsc --noEmit", test: "bun test" },
    }

    const text = EditPlanning.formatImpact(impact)
    expect(text).toContain("processOrder")
    expect(text).toContain("handleRequest")
    expect(text).toContain("src/api.ts:15")
    expect(text).toContain("test_order_processing")
    expect(text).toContain("verify")
  })

  test("handles empty impact gracefully", () => {
    const impact: EditPlanning.EditImpact = {
      targetSymbols: ["unknownSymbol"],
      directCallers: [],
      affectedFiles: [],
      affectedTests: [],
      verifyCommands: {},
    }

    const text = EditPlanning.formatImpact(impact)
    expect(text).toContain("No impact data")
  })
})
