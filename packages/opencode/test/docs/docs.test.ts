import { describe, expect, test, beforeEach } from "bun:test"
import { DtsParser } from "../../src/docs/dts-parser"
import { Docs } from "../../src/docs"

describe("DtsParser", () => {
  test("parses exported function", () => {
    const content = `export function createApp(config: AppConfig): App;`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("createApp")
    expect(results[0].kind).toBe("function")
    expect(results[0].source).toBe("test-pkg")
    expect(results[0].returnType).toBe("App")
  })

  test("parses exported interface", () => {
    const content = `export interface Config {
  host: string;
  port: number;
}`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("Config")
    expect(results[0].kind).toBe("interface")
  })

  test("parses exported type", () => {
    const content = `export type Handler = (req: Request, res: Response) => void;`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("Handler")
    expect(results[0].kind).toBe("type")
  })

  test("parses exported class", () => {
    const content = `export class Router {
  constructor(options?: RouterOptions);
}`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("Router")
    expect(results[0].kind).toBe("class")
  })

  test("parses exported const", () => {
    const content = `export const VERSION: string = "1.0.0";`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("VERSION")
    expect(results[0].kind).toBe("const")
  })

  test("parses exported enum", () => {
    const content = `export enum Status { Active, Inactive }`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("Status")
    expect(results[0].kind).toBe("enum")
  })

  test("parses exported namespace", () => {
    const content = `export namespace Utils {}`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("Utils")
    expect(results[0].kind).toBe("namespace")
  })

  test("extracts JSDoc description", () => {
    const content = `/**
 * Creates a new application instance.
 * @param config - Application configuration
 */
export function createApp(config: AppConfig): App;`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].description).toContain("Creates a new application")
  })

  test("extracts function parameters", () => {
    const content = `/**
 * Send a message.
 * @param to - Recipient
 * @param body - Message body
 */
export function send(to: string, body: string): void;`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results[0].parameters).toBeDefined()
    expect(results[0].parameters!.length).toBe(2)
    expect(results[0].parameters![0].name).toBe("to")
    expect(results[0].parameters![0].type).toBe("string")
  })

  test("parses declare function", () => {
    const content = `declare function parse(input: string): object;`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("parse")
    expect(results[0].kind).toBe("function")
  })

  test("skips non-export lines", () => {
    const content = `const internal = "hidden"
function helper() {}
export function publicApi(): void;`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(1)
    expect(results[0].name).toBe("publicApi")
  })

  test("handles multiple exports in one file", () => {
    const content = `export function a(): void;
export function b(): string;
export interface C {}
export type D = string;`
    const results = DtsParser.parse(content, "test-pkg")

    expect(results.length).toBe(4)
  })
})

describe("Docs", () => {
  beforeEach(() => {
    Docs.clearIndex()
  })

  test("lookup returns empty for unknown symbol", () => {
    const results = Docs.lookup("NonExistent")
    expect(results.length).toBe(0)
  })

  test("search returns empty for no index", () => {
    const results = Docs.search("anything")
    expect(results.length).toBe(0)
  })

  test("stats reports zero initially", () => {
    const stats = Docs.stats()
    expect(stats.packages).toBe(0)
    expect(stats.symbols).toBe(0)
  })

  test("format returns message for empty results", () => {
    const output = Docs.format([])
    expect(output).toContain("No matching types found")
  })

  test("format formats type info entries", () => {
    const infos: Docs.TypeInfo[] = [{
      name: "createApp",
      kind: "function",
      signature: "function createApp(config: AppConfig): App",
      description: "Creates a new app",
      source: "test-pkg",
      returnType: "App",
      parameters: [{ name: "config", type: "AppConfig", optional: false }],
    }]
    const output = Docs.format(infos)
    expect(output).toContain("createApp")
    expect(output).toContain("test-pkg")
    expect(output).toContain("config")
  })

  test("format respects maxChars limit", () => {
    const infos: Docs.TypeInfo[] = Array.from({ length: 50 }, (_, i) => ({
      name: `symbol${i}`,
      kind: "function" as const,
      signature: `function symbol${i}(): void`,
      source: "test-pkg",
    }))
    const output = Docs.format(infos, 200)
    expect(output.length).toBeLessThanOrEqual(250) // Some margin for last entry
  })
})
