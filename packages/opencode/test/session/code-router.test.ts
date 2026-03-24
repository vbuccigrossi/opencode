import { describe, expect, test } from "bun:test"
import { CodeRouter } from "../../src/session/code-router"

describe("CodeRouter", () => {
  describe("buildContext", () => {
    test("extracts recent messages", () => {
      const messages = [
        { role: "user", content: "Fix the auth bug in login.ts" },
        { role: "assistant", content: "I'll look at the login module and fix the authentication issue." },
        { role: "user", content: "Also add input validation" },
      ]
      const ctx = CodeRouter.buildContext(messages)
      expect(ctx).toContain("Fix the auth bug")
      expect(ctx).toContain("authentication issue")
      expect(ctx).toContain("input validation")
    })

    test("respects maxLen limit", () => {
      const messages = [
        { role: "user", content: "A".repeat(5000) },
        { role: "assistant", content: "B".repeat(5000) },
      ]
      const ctx = CodeRouter.buildContext(messages, 1000)
      // Should be truncated — each message gets sliced to 500 chars
      expect(ctx.length).toBeLessThan(2000)
    })

    test("handles empty messages", () => {
      const ctx = CodeRouter.buildContext([])
      expect(ctx).toBe("No additional context.")
    })

    test("handles messages with parts array", () => {
      const messages = [
        {
          role: "user",
          parts: [{ type: "text", text: "Write a function" }],
        },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "I'll create the function now." },
            { type: "tool", text: undefined },
          ],
        },
      ]
      const ctx = CodeRouter.buildContext(messages)
      // These use parts, not content — buildContext checks content first
      // Messages without content field will be skipped
      expect(typeof ctx).toBe("string")
    })

    test("prioritizes recent messages", () => {
      const messages = [
        { role: "user", content: "old message that should be dropped" },
        { role: "assistant", content: "old response" },
        { role: "user", content: "recent important message" },
        { role: "assistant", content: "recent response about the fix" },
      ]
      const ctx = CodeRouter.buildContext(messages, 200)
      // With tight maxLen, should prioritize more recent messages
      expect(ctx).toContain("recent")
    })
  })

  describe("shouldRoute", () => {
    const ollamaModel = {
      providerID: "ollama",
      id: "devstral-small:latest",
    } as any

    const anthropicModel = {
      providerID: "anthropic",
      id: "claude-sonnet-4-20250514",
    } as any

    test("routes edit tool for ollama models", () => {
      expect(CodeRouter.shouldRoute("edit", ollamaModel)).toBe(true)
    })

    test("routes write tool for ollama models", () => {
      expect(CodeRouter.shouldRoute("write", ollamaModel)).toBe(true)
    })

    test("does not route bash tool", () => {
      expect(CodeRouter.shouldRoute("bash", ollamaModel)).toBe(false)
    })

    test("does not route read tool", () => {
      expect(CodeRouter.shouldRoute("read", ollamaModel)).toBe(false)
    })

    test("does not route grep tool", () => {
      expect(CodeRouter.shouldRoute("grep", ollamaModel)).toBe(false)
    })

    test("does not route for non-ollama providers", () => {
      expect(CodeRouter.shouldRoute("edit", anthropicModel)).toBe(false)
      expect(CodeRouter.shouldRoute("write", anthropicModel)).toBe(false)
    })
  })

  describe("extractCode (via integration)", () => {
    // extractCode is private, but we can test it indirectly through
    // the prompt format expectations

    test("buildContext handles undefined content gracefully", () => {
      const messages = [
        { role: "user", content: undefined },
        { role: "assistant", content: "Some response" },
        { role: "user" }, // no content at all
      ]
      const ctx = CodeRouter.buildContext(messages as any)
      expect(ctx).toContain("Some response")
    })

    test("buildContext walks backwards", () => {
      // With a very small maxLen, it should get the last messages first
      const messages = [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
        { role: "user", content: "third" },
      ]
      const ctx = CodeRouter.buildContext(messages, 50)
      expect(ctx).toContain("third")
    })
  })
})
