import { describe, expect, test } from "bun:test"
import { Scratchpad } from "../../src/scratchpad"

function makeMessages(thoughtCount: number) {
  const parts = Array.from({ length: thoughtCount }, (_, i) => ({
    type: "tool" as const,
    tool: "think",
    state: {
      status: "completed" as const,
      input: { thought: `Thought number ${i + 1}: this is some reasoning about the problem at hand` },
      output: "Thought recorded.",
      time: { start: Date.now(), end: Date.now() },
      metadata: {},
    },
  }))

  return [
    {
      info: { role: "assistant" as const, id: "msg_1" },
      parts,
    },
  ]
}

describe("scratchpad.dynamicLimits", () => {
  test("respects custom maxThoughts", () => {
    const msgs = makeMessages(10)
    const result = Scratchpad.format(msgs as any, { maxThoughts: 3 })
    expect(result).toBeDefined()
    // Should only have 3 thought entries
    const entries = result!.split("\n").filter((l) => l.startsWith("["))
    expect(entries).toHaveLength(3)
  })

  test("respects custom maxChars", () => {
    const msgs = makeMessages(20)
    const result = Scratchpad.format(msgs as any, { maxChars: 500 })
    expect(result).toBeDefined()
    expect(result!.length).toBeLessThanOrEqual(550) // Small buffer for closing tag
  })

  test("uses default limits when no options", () => {
    const msgs = makeMessages(5)
    const result = Scratchpad.format(msgs as any)
    expect(result).toBeDefined()
    const entries = result!.split("\n").filter((l) => l.startsWith("["))
    expect(entries).toHaveLength(5)
  })

  test("large maxThoughts allows more thoughts", () => {
    const msgs = makeMessages(25)
    const small = Scratchpad.format(msgs as any, { maxThoughts: 10, maxChars: 50000 })
    const large = Scratchpad.format(msgs as any, { maxThoughts: 25, maxChars: 50000 })

    const smallEntries = small!.split("\n").filter((l) => l.startsWith("["))
    const largeEntries = large!.split("\n").filter((l) => l.startsWith("["))

    expect(smallEntries).toHaveLength(10)
    expect(largeEntries).toHaveLength(25)
  })
})
