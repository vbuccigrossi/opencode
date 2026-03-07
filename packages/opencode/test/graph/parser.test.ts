import { describe, expect, test } from "bun:test"
import { GraphParser } from "../../src/graph/parser"

describe("graph.parser", () => {
  describe("languageForFile", () => {
    test("identifies typescript files", () => {
      expect(GraphParser.languageForFile("foo.ts")).toBe("typescript")
      expect(GraphParser.languageForFile("src/bar.ts")).toBe("typescript")
    })

    test("identifies tsx files separately", () => {
      expect(GraphParser.languageForFile("component.tsx")).toBe("tsx")
      expect(GraphParser.languageForFile("app.jsx")).toBe("tsx")
    })

    test("identifies javascript files", () => {
      expect(GraphParser.languageForFile("index.js")).toBe("javascript")
      expect(GraphParser.languageForFile("config.mjs")).toBe("javascript")
      expect(GraphParser.languageForFile("util.cjs")).toBe("javascript")
    })

    test("identifies python files", () => {
      expect(GraphParser.languageForFile("main.py")).toBe("python")
    })

    test("identifies go files", () => {
      expect(GraphParser.languageForFile("main.go")).toBe("go")
    })

    test("identifies rust files", () => {
      expect(GraphParser.languageForFile("lib.rs")).toBe("rust")
    })

    test("identifies java files", () => {
      expect(GraphParser.languageForFile("Main.java")).toBe("java")
    })

    test("identifies C/C++ files", () => {
      expect(GraphParser.languageForFile("main.c")).toBe("c")
      expect(GraphParser.languageForFile("header.h")).toBe("c")
      expect(GraphParser.languageForFile("main.cpp")).toBe("cpp")
      expect(GraphParser.languageForFile("main.cc")).toBe("cpp")
    })

    test("returns undefined for unsupported files", () => {
      expect(GraphParser.languageForFile("readme.md")).toBeUndefined()
      expect(GraphParser.languageForFile("data.json")).toBeUndefined()
      expect(GraphParser.languageForFile("style.css")).toBeUndefined()
      expect(GraphParser.languageForFile("image.png")).toBeUndefined()
    })

    test("handles case insensitivity", () => {
      expect(GraphParser.languageForFile("FOO.TS")).toBe("typescript")
      expect(GraphParser.languageForFile("BAR.PY")).toBe("python")
    })
  })

  describe("isSupported", () => {
    test("returns true for supported extensions", () => {
      expect(GraphParser.isSupported("foo.ts")).toBe(true)
      expect(GraphParser.isSupported("bar.py")).toBe(true)
      expect(GraphParser.isSupported("baz.go")).toBe(true)
    })

    test("returns false for unsupported extensions", () => {
      expect(GraphParser.isSupported("readme.md")).toBe(false)
      expect(GraphParser.isSupported("data.json")).toBe(false)
    })
  })

  describe("extractorLanguageFor", () => {
    test("maps tsx to typescript", () => {
      expect(GraphParser.extractorLanguageFor("tsx")).toBe("typescript")
    })

    test("passes through other languages unchanged", () => {
      expect(GraphParser.extractorLanguageFor("typescript")).toBe("typescript")
      expect(GraphParser.extractorLanguageFor("python")).toBe("python")
      expect(GraphParser.extractorLanguageFor("go")).toBe("go")
    })
  })

  describe("parse", () => {
    test("parses typescript source code", async () => {
      const source = `function hello(): string { return "world" }`
      const tree = await GraphParser.parse("test.ts", source)
      expect(tree).toBeDefined()
      expect(tree!.rootNode.type).toBe("program")
    })

    test("parses python source code", async () => {
      const source = `def hello():\n    return "world"`
      const tree = await GraphParser.parse("test.py", source)
      expect(tree).toBeDefined()
      expect(tree!.rootNode.type).toBe("module")
    })

    test("returns undefined for unsupported files", async () => {
      const tree = await GraphParser.parse("readme.md", "# Hello")
      expect(tree).toBeUndefined()
    })

    test("handles empty source code", async () => {
      const tree = await GraphParser.parse("empty.ts", "")
      expect(tree).toBeDefined()
    })

    test("handles malformed source code gracefully", async () => {
      const source = `function { broken syntax {{{{ `
      const tree = await GraphParser.parse("broken.ts", source)
      // tree-sitter is error-tolerant — it should still return a tree
      expect(tree).toBeDefined()
    })
  })
})
