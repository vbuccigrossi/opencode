import { describe, expect, test } from "bun:test"
import { Scratchpad } from "../../src/scratchpad"
import type { MessageV2 } from "../../src/session/message-v2"

/** Helper to create a mock message with parts */
function mockMessage(
  role: "user" | "assistant",
  parts: MessageV2.Part[],
): MessageV2.WithParts {
  return {
    info: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      sessionID: "test-session",
      role,
      time: { created: Date.now() },
      ...(role === "user"
        ? { agent: "default", model: { providerID: "test", modelID: "test" } }
        : {
            mode: "default",
            agent: "default",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            path: { cwd: "/tmp", root: "/tmp" },
          }),
    } as any,
    parts,
  }
}

/** Helper to create a completed think tool part */
function thinkPart(thought: string): MessageV2.ToolPart {
  return {
    id: `part-${Math.random().toString(36).slice(2, 8)}`,
    sessionID: "test-session",
    messageID: "test-msg",
    type: "tool",
    tool: "think",
    callID: `call-${Math.random().toString(36).slice(2, 8)}`,
    state: {
      status: "completed",
      input: { thought },
      output: "Thought recorded.",
      title: "Thinking...",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  } as unknown as MessageV2.ToolPart
}

/** Helper to create a non-think tool part */
function otherToolPart(tool: string, input: Record<string, any>): MessageV2.ToolPart {
  return {
    id: `part-${Math.random().toString(36).slice(2, 8)}`,
    sessionID: "test-session",
    messageID: "test-msg",
    type: "tool",
    tool,
    callID: `call-${Math.random().toString(36).slice(2, 8)}`,
    state: {
      status: "completed",
      input,
      output: "Done.",
      title: "",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  } as unknown as MessageV2.ToolPart
}

describe("scratchpad", () => {
  describe("extractThoughts", () => {
    test("returns empty array for no messages", () => {
      expect(Scratchpad.extractThoughts([])).toEqual([])
    })

    test("returns empty array for user-only messages", () => {
      const msgs = [
        mockMessage("user", [
          {
            id: "p1",
            sessionID: "s",
            messageID: "m",
            type: "text",
            text: "Hello",
          } as MessageV2.TextPart,
        ]),
      ]
      expect(Scratchpad.extractThoughts(msgs)).toEqual([])
    })

    test("extracts thought from completed think tool", () => {
      const msgs = [
        mockMessage("assistant", [thinkPart("Need to analyze the auth module first")]),
      ]
      const thoughts = Scratchpad.extractThoughts(msgs)
      expect(thoughts).toHaveLength(1)
      expect(thoughts[0]).toBe("Need to analyze the auth module first")
    })

    test("extracts multiple thoughts in order", () => {
      const msgs = [
        mockMessage("assistant", [
          thinkPart("Step 1: Read the config"),
          otherToolPart("read", { file_path: "/src/config.ts" }),
          thinkPart("Step 2: The config uses zod schemas"),
        ]),
        mockMessage("assistant", [
          thinkPart("Step 3: Now I need to modify the validator"),
        ]),
      ]
      const thoughts = Scratchpad.extractThoughts(msgs)
      expect(thoughts).toHaveLength(3)
      expect(thoughts[0]).toBe("Step 1: Read the config")
      expect(thoughts[1]).toBe("Step 2: The config uses zod schemas")
      expect(thoughts[2]).toBe("Step 3: Now I need to modify the validator")
    })

    test("ignores non-think tool calls", () => {
      const msgs = [
        mockMessage("assistant", [
          otherToolPart("bash", { command: "ls" }),
          otherToolPart("read", { file_path: "/tmp/test.ts" }),
        ]),
      ]
      expect(Scratchpad.extractThoughts(msgs)).toEqual([])
    })

    test("ignores think calls with empty thought", () => {
      const msgs = [
        mockMessage("assistant", [
          thinkPart(""),
          thinkPart("   "),
          thinkPart("Valid thought"),
        ]),
      ]
      const thoughts = Scratchpad.extractThoughts(msgs)
      expect(thoughts).toHaveLength(1)
      expect(thoughts[0]).toBe("Valid thought")
    })

    test("handles think tool with error status", () => {
      const errorPart: MessageV2.ToolPart = {
        id: "p1",
        sessionID: "s",
        messageID: "m",
        type: "tool",
        tool: "think",
        callID: "c1",
        state: {
          status: "error",
          input: { thought: "This errored but thought should still be captured" },
          error: "Some error",
          time: { start: Date.now(), end: Date.now() },
        },
      } as unknown as MessageV2.ToolPart
      const msgs = [mockMessage("assistant", [errorPart])]
      const thoughts = Scratchpad.extractThoughts(msgs)
      expect(thoughts).toHaveLength(1)
      expect(thoughts[0]).toBe("This errored but thought should still be captured")
    })

    test("ignores pending/running think calls", () => {
      const pendingPart: MessageV2.ToolPart = {
        id: "p1",
        sessionID: "s",
        messageID: "m",
        type: "tool",
        tool: "think",
        callID: "c1",
        state: {
          status: "pending",
          input: {},
          raw: "",
        },
      } as unknown as MessageV2.ToolPart
      const msgs = [mockMessage("assistant", [pendingPart])]
      expect(Scratchpad.extractThoughts(msgs)).toEqual([])
    })
  })

  describe("format", () => {
    test("returns undefined for no thoughts", () => {
      expect(Scratchpad.format([])).toBeUndefined()
    })

    test("returns undefined for messages without think calls", () => {
      const msgs = [
        mockMessage("assistant", [
          otherToolPart("bash", { command: "echo hello" }),
        ]),
      ]
      expect(Scratchpad.format(msgs)).toBeUndefined()
    })

    test("formats single thought", () => {
      const msgs = [
        mockMessage("assistant", [thinkPart("The bug is in the parser")]),
      ]
      const result = Scratchpad.format(msgs)!
      expect(result).toContain("<scratchpad>")
      expect(result).toContain("</scratchpad>")
      expect(result).toContain("The bug is in the parser")
      expect(result).toContain("[1]")
    })

    test("formats multiple thoughts with indices", () => {
      const msgs = [
        mockMessage("assistant", [
          thinkPart("First: read the file"),
          thinkPart("Second: the issue is on line 42"),
          thinkPart("Third: fix the off-by-one error"),
        ]),
      ]
      const result = Scratchpad.format(msgs)!
      expect(result).toContain("[1] First: read the file")
      expect(result).toContain("[2] Second: the issue is on line 42")
      expect(result).toContain("[3] Third: fix the off-by-one error")
    })

    test("truncates when exceeding character limit", () => {
      // Create many long thoughts to exceed the 8000 char limit
      const longThought = "A".repeat(500)
      const parts = Array.from({ length: 25 }, () => thinkPart(longThought))
      const msgs = [mockMessage("assistant", parts)]
      const result = Scratchpad.format(msgs)!
      expect(result).toContain("<scratchpad>")
      expect(result).toContain("</scratchpad>")
      expect(result).toContain("earlier thoughts omitted")
      // Should be under the limit
      expect(result.length).toBeLessThan(9000)
    })
  })
})
