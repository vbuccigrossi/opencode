import { describe, expect, test, beforeEach } from "bun:test"
import { Knowledge } from "../../src/knowledge"
import { Extractor } from "../../src/knowledge/extractor"
import type { MessageV2 } from "../../src/session/message-v2"

/** Helper to create a mock message with parts. */
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

/** Helper to create a think tool part. */
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

/** Helper to create a read tool part. */
function readPart(filePath: string, output: string): MessageV2.ToolPart {
  return {
    id: `part-${Math.random().toString(36).slice(2, 8)}`,
    sessionID: "test-session",
    messageID: "test-msg",
    type: "tool",
    tool: "read",
    callID: `call-${Math.random().toString(36).slice(2, 8)}`,
    state: {
      status: "completed",
      input: { file_path: filePath },
      output,
      title: `read: ${filePath}`,
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  } as unknown as MessageV2.ToolPart
}

/** Helper to create a text part. */
function textPart(content: string): MessageV2.Part {
  return {
    id: `part-${Math.random().toString(36).slice(2, 8)}`,
    sessionID: "test-session",
    messageID: "test-msg",
    type: "text",
    content,
  } as any
}

describe("Extractor", () => {
  describe("file role extraction", () => {
    test("detects file role from think thoughts", () => {
      const messages = [
        mockMessage("assistant", [
          thinkPart("Looking at src/main.ts, this appears to be the entry point for the application."),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const roleFactes = facts.filter((f) => f.category === "file_role")
      expect(roleFactes.length).toBeGreaterThan(0)
      expect(roleFactes[0].subject).toContain("main.ts")
      expect(roleFactes[0].content).toContain("entry point")
    })

    test("detects config file from think thoughts", () => {
      const messages = [
        mockMessage("assistant", [
          thinkPart("The settings.ts file is the configuration for this module."),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const roleFacts = facts.filter((f) => f.category === "file_role")
      expect(roleFacts.length).toBeGreaterThan(0)
      expect(roleFacts.some((f) => f.content.includes("config"))).toBe(true)
    })

    test("detects test file from read tool", () => {
      const messages = [
        mockMessage("assistant", [
          readPart("src/utils.test.ts", 'import { describe, test } from "bun:test"'),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const roleFacts = facts.filter((f) => f.category === "file_role")
      expect(roleFacts.length).toBeGreaterThan(0)
      expect(roleFacts[0].content).toContain("test file")
    })

    test("detects config file from read tool", () => {
      const messages = [
        mockMessage("assistant", [
          readPart("tsconfig.json", '{ "compilerOptions": {} }'),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const roleFacts = facts.filter((f) => f.category === "file_role")
      // config detection is filename-based
      expect(roleFacts.some((f) => f.content.includes("configuration"))).toBe(true)
    })

    test("detects index/barrel file from read tool", () => {
      const messages = [
        mockMessage("assistant", [
          readPart("src/index.ts", 'export { Foo } from "./foo"\nexport { Bar } from "./bar"'),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const roleFacts = facts.filter((f) => f.category === "file_role")
      expect(roleFacts.some((f) => f.content.includes("barrel") || f.content.includes("index"))).toBe(true)
    })
  })

  describe("code pattern extraction", () => {
    test("detects convention from think thought", () => {
      const messages = [
        mockMessage("assistant", [
          thinkPart("All handlers in this project return Response objects with JSON."),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const patternFacts = facts.filter((f) => f.category === "code_pattern")
      expect(patternFacts.length).toBeGreaterThan(0)
    })

    test("detects explicit convention", () => {
      const messages = [
        mockMessage("assistant", [
          thinkPart("This codebase uses TypeScript namespaces for all modules."),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const convFacts = facts.filter((f) => f.category === "convention")
      expect(convFacts.length).toBeGreaterThan(0)
    })
  })

  describe("error pattern extraction", () => {
    test("detects error-fix pattern", () => {
      const messages = [
        mockMessage("assistant", [
          thinkPart('The error "cannot find module \'@/foo\'" was fixed by adding the path alias to tsconfig.'),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const errorFacts = facts.filter((f) => f.category === "error_pattern")
      expect(errorFacts.length).toBeGreaterThan(0)
      expect(errorFacts[0].content).toContain("Fix:")
    })
  })

  describe("dependency extraction", () => {
    test("detects import dependency from text", () => {
      const messages = [
        mockMessage("assistant", [
          textPart("The file handler.ts imports the auth module from auth.ts for authentication."),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const depFacts = facts.filter((f) => f.category === "dependency")
      expect(depFacts.length).toBeGreaterThan(0)
      expect(depFacts[0].content).toContain("depends on")
    })
  })

  describe("deduplication", () => {
    test("deduplicates identical facts", () => {
      const messages = [
        mockMessage("assistant", [
          thinkPart("Looking at src/main.ts, this is the entry point. The entry point is src/main.ts."),
        ]),
      ]

      const facts = Extractor.extract(messages)
      const mainFacts = facts.filter((f) => f.subject?.includes("main.ts"))
      // Should deduplicate to 1
      expect(mainFacts.length).toBeLessThanOrEqual(1)
    })
  })
})

describe("Knowledge", () => {
  const sessionID = "test-session-123"

  beforeEach(() => {
    Knowledge.clearAll()
  })

  describe("store", () => {
    test("stores facts", () => {
      const facts: Knowledge.Fact[] = [
        {
          id: "f1",
          category: "file_role",
          subject: "src/main.ts",
          content: "src/main.ts is the entry point",
          confidence: 0.8,
          source: "observed",
        },
      ]

      const added = Knowledge.store(sessionID, facts)
      expect(added).toBe(1)
      expect(Knowledge.count(sessionID)).toBe(1)
    })

    test("deduplicates on store", () => {
      const facts: Knowledge.Fact[] = [
        {
          id: "f1",
          category: "file_role",
          subject: "src/main.ts",
          content: "src/main.ts is the entry point",
          confidence: 0.8,
          source: "observed",
        },
      ]

      Knowledge.store(sessionID, facts)
      const added2 = Knowledge.store(sessionID, facts)
      expect(added2).toBe(0) // Duplicate, not added
      expect(Knowledge.count(sessionID)).toBe(1)
    })

    test("updates confidence on duplicate", () => {
      Knowledge.store(sessionID, [
        {
          id: "f1",
          category: "file_role",
          subject: "src/main.ts",
          content: "src/main.ts is the entry point",
          confidence: 0.5,
          source: "inferred",
        },
      ])

      Knowledge.store(sessionID, [
        {
          id: "f2",
          category: "file_role",
          subject: "src/main.ts",
          content: "src/main.ts is the entry point",
          confidence: 0.9,
          source: "observed",
        },
      ])

      const facts = Knowledge.all(sessionID)
      expect(facts.length).toBe(1)
      expect(facts[0].confidence).toBe(0.9)
    })

    test("caps at max facts", () => {
      const facts = Array.from({ length: 150 }, (_, i) => ({
        id: `f-${i}`,
        category: "file_role" as const,
        subject: `file-${i}.ts`,
        content: `file-${i}.ts has role ${i}`,
        confidence: Math.random(),
        source: "observed" as const,
      }))

      Knowledge.store(sessionID, facts)
      expect(Knowledge.count(sessionID)).toBeLessThanOrEqual(100)
    })
  })

  describe("retrieve", () => {
    test("retrieves by relevance to context", () => {
      Knowledge.store(sessionID, [
        {
          id: "f1",
          category: "file_role",
          subject: "auth.ts",
          content: "auth.ts handles authentication",
          confidence: 0.8,
          source: "observed",
        },
        {
          id: "f2",
          category: "file_role",
          subject: "math.ts",
          content: "math.ts has utility math functions",
          confidence: 0.8,
          source: "observed",
        },
      ])

      const relevant = Knowledge.retrieve(sessionID, "authentication login")
      expect(relevant.length).toBeGreaterThan(0)
      expect(relevant[0].subject).toBe("auth.ts")
    })

    test("returns highest confidence without context", () => {
      Knowledge.store(sessionID, [
        {
          id: "f1",
          category: "file_role",
          subject: "low.ts",
          content: "low confidence fact",
          confidence: 0.3,
          source: "inferred",
        },
        {
          id: "f2",
          category: "file_role",
          subject: "high.ts",
          content: "high confidence fact",
          confidence: 0.9,
          source: "observed",
        },
      ])

      const facts = Knowledge.retrieve(sessionID)
      expect(facts[0].subject).toBe("high.ts")
    })

    test("respects maxFacts limit", () => {
      Knowledge.store(
        sessionID,
        Array.from({ length: 20 }, (_, i) => ({
          id: `f-${i}`,
          category: "file_role" as const,
          subject: `file-${i}.ts`,
          content: `file-${i}.ts info`,
          confidence: 0.5,
          source: "observed" as const,
        })),
      )

      const facts = Knowledge.retrieve(sessionID, undefined, 5)
      expect(facts.length).toBe(5)
    })
  })

  describe("format", () => {
    test("returns empty string for no facts", () => {
      expect(Knowledge.format(sessionID)).toBe("")
    })

    test("formats facts as knowledge block", () => {
      Knowledge.store(sessionID, [
        {
          id: "f1",
          category: "file_role",
          subject: "main.ts",
          content: "main.ts is the entry point",
          confidence: 0.8,
          source: "observed",
        },
        {
          id: "f2",
          category: "convention",
          subject: "codebase",
          content: "Uses TypeScript namespaces",
          confidence: 0.7,
          source: "inferred",
        },
      ])

      const formatted = Knowledge.format(sessionID)
      expect(formatted).toContain("<knowledge>")
      expect(formatted).toContain("</knowledge>")
      expect(formatted).toContain("File Roles")
      expect(formatted).toContain("main.ts is the entry point")
      expect(formatted).toContain("Conventions")
    })

    test("respects maxChars", () => {
      Knowledge.store(
        sessionID,
        Array.from({ length: 50 }, (_, i) => ({
          id: `f-${i}`,
          category: "file_role" as const,
          subject: `very-long-file-name-${i}.ts`,
          content: `very-long-file-name-${i}.ts has a very long role description that takes up lots of space`,
          confidence: 0.5,
          source: "observed" as const,
        })),
      )

      const formatted = Knowledge.format(sessionID, undefined, 300)
      expect(formatted.length).toBeLessThan(350) // Some overhead from tags
    })
  })

  describe("clear", () => {
    test("clears session facts", () => {
      Knowledge.store(sessionID, [
        {
          id: "f1",
          category: "file_role",
          subject: "test.ts",
          content: "test",
          confidence: 0.5,
          source: "observed",
        },
      ])

      expect(Knowledge.count(sessionID)).toBe(1)
      Knowledge.clear(sessionID)
      expect(Knowledge.count(sessionID)).toBe(0)
    })
  })
})
