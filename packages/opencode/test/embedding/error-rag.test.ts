import { describe, it, expect } from "bun:test"
import { ErrorRAG } from "../../src/embedding/error-rag"

/**
 * Tests for the Error-Aware RAG module.
 *
 * Covers error extraction from Go, Rust, Python, TypeScript, and C/C++
 * compiler output, query generation, and the injection lifecycle.
 */

// ---------------------------------------------------------------------------
// hasCompilationErrors
// ---------------------------------------------------------------------------

describe("ErrorRAG.hasCompilationErrors", () => {
  it("detects Go undefined symbol errors", () => {
    const output = `./main.go:15:2: undefined: http.ListenAndServes`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects Go type mismatch errors", () => {
    const output = `./main.go:10:5: cannot use x (variable of type string) as int value in argument`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects Go file:line:col errors", () => {
    const output = `./server.go:42:15: too many arguments in call to http.Get`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects Go package header errors", () => {
    const output = `# myproject/cmd/server\n./main.go:5:2: undefined: Setup`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects Rust errors", () => {
    const output = `error[E0433]: failed to resolve: use of undeclared crate or module \`tokio\``
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects Rust cannot find errors", () => {
    const output = `error[E0425]: cannot find function \`spawn\` in this scope`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects Python ModuleNotFoundError", () => {
    const output = `ModuleNotFoundError: No module named 'requests'`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects Python ImportError", () => {
    const output = `ImportError: cannot import name 'Flask' from 'flask'`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects Python NameError", () => {
    const output = `NameError: name 'undefined_var' is not defined`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects TypeScript module errors", () => {
    const output = `error TS2307: Cannot find module 'express'`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects TypeScript errors by code", () => {
    const output = `src/index.ts(5,10): error TS2339: Property 'foo' does not exist on type 'Bar'.`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects C/C++ undefined reference", () => {
    const output = `undefined reference to 'pthread_create'`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("detects general build failures", () => {
    expect(ErrorRAG.hasCompilationErrors("BUILD FAILURE")).toBe(true)
    expect(ErrorRAG.hasCompilationErrors("compilation failed")).toBe(true)
    expect(ErrorRAG.hasCompilationErrors("FAILED: build.ninja")).toBe(true)
  })

  it("detects generic error: prefix", () => {
    const output = `error: something went wrong\nsome other output`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(true)
  })

  it("returns false for successful output", () => {
    const output = `Build successful\n3 tests passed\nDone.`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(false)
  })

  it("returns false for empty output", () => {
    expect(ErrorRAG.hasCompilationErrors("")).toBe(false)
  })

  it("returns false for normal command output", () => {
    const output = `total 42\ndrwxr-xr-x  5 user user 4096 Mar 21 10:00 .\n-rw-r--r--  1 user user  123 Mar 21 10:00 file.txt`
    expect(ErrorRAG.hasCompilationErrors(output)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractErrorInfo
// ---------------------------------------------------------------------------

describe("ErrorRAG.extractErrorInfo", () => {
  it("extracts Go undefined symbols", () => {
    const output = `./main.go:15:2: undefined: ListenAndServe
./main.go:20:5: undefined: DefaultServeMux`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.symbols).toContain("ListenAndServe")
    expect(info.symbols).toContain("DefaultServeMux")
    expect(info.errorMessages.length).toBeGreaterThan(0)
  })

  it("extracts Go package.Symbol references", () => {
    const output = `./main.go:10:2: undefined: http.ListenAndServe
./main.go:12:5: cannot use tls.Config as net.Config`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.packages).toContain("http")
    expect(info.packages).toContain("tls")
    expect(info.symbols).toContain("http.ListenAndServe")
    expect(info.symbols).toContain("tls.Config")
  })

  it("extracts Go type mismatch symbols", () => {
    const output = `cannot use myHandler as http.Handler in argument`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.symbols).toContain("myHandler")
    expect(info.symbols).toContain("http.Handler")
    expect(info.packages).toContain("http")
  })

  it("extracts Go package headers", () => {
    const output = `# github.com/myorg/myproject/server
./server.go:5:2: undefined: Setup`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.packages).toContain("server")
  })

  it("extracts Go import errors", () => {
    const output = `could not import crypto/tls (no required module provides package "crypto/tls")`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.packages).toContain("crypto/tls")
  })

  it("extracts Rust crate references", () => {
    const output = `error[E0433]: cannot find function \`spawn\` in crate \`tokio\``
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.symbols).toContain("spawn")
    expect(info.packages).toContain("tokio")
  })

  it("extracts Python module names", () => {
    const output = `ModuleNotFoundError: No module named 'requests.auth'
ImportError: No module named 'flask'`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.packages).toContain("requests")
    expect(info.packages).toContain("flask")
  })

  it("extracts Python NameError symbols", () => {
    const output = `NameError: name 'undefined_func' is not defined`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.symbols).toContain("undefined_func")
  })

  it("extracts TypeScript module names", () => {
    const output = `error TS2307: Cannot find module 'express'`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.packages).toContain("express")
  })

  it("extracts C/C++ undefined references", () => {
    const output = `undefined reference to 'pthread_create'
undefined reference to 'dlopen'`
    const info = ErrorRAG.extractErrorInfo(output)

    expect(info.symbols).toContain("pthread_create")
    expect(info.symbols).toContain("dlopen")
  })

  it("limits error messages to 5", () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `./main.go:${i}:1: error: something wrong ${i}`
    ).join("\n")
    const info = ErrorRAG.extractErrorInfo(lines)

    expect(info.errorMessages.length).toBeLessThanOrEqual(5)
  })

  it("truncates raw output to 500 chars", () => {
    const longOutput = "x".repeat(1000) + "\nundefined: foo"
    const info = ErrorRAG.extractErrorInfo(longOutput)

    expect(info.output.length).toBeLessThanOrEqual(500)
  })

  it("handles empty output", () => {
    const info = ErrorRAG.extractErrorInfo("")

    expect(info.packages).toEqual([])
    expect(info.symbols).toEqual([])
    expect(info.errorMessages).toEqual([])
  })

  it("deduplicates packages and symbols", () => {
    const output = `./a.go:1:1: undefined: http.Get
./b.go:2:1: undefined: http.Post
./c.go:3:1: http.Handler not found`
    const info = ErrorRAG.extractErrorInfo(output)

    // http should appear only once in packages
    const httpCount = info.packages.filter((p) => p === "http").length
    expect(httpCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// buildQueries
// ---------------------------------------------------------------------------

describe("ErrorRAG.buildQueries", () => {
  it("generates package documentation queries", () => {
    const info: ErrorRAG.ErrorInfo = {
      output: "",
      packages: ["http", "tls"],
      symbols: [],
      errorMessages: [],
    }
    const queries = ErrorRAG.buildQueries(info)

    expect(queries.length).toBe(2)
    expect(queries[0]).toContain("http")
    expect(queries[0]).toContain("API documentation")
    expect(queries[1]).toContain("tls")
  })

  it("generates symbol queries", () => {
    const info: ErrorRAG.ErrorInfo = {
      output: "",
      packages: [],
      symbols: ["ListenAndServe", "DefaultServeMux"],
      errorMessages: [],
    }
    const queries = ErrorRAG.buildQueries(info)

    expect(queries.length).toBe(1)
    expect(queries[0]).toContain("ListenAndServe")
    expect(queries[0]).toContain("function signature")
  })

  it("combines package and symbol queries", () => {
    const info: ErrorRAG.ErrorInfo = {
      output: "",
      packages: ["http"],
      symbols: ["ListenAndServe"],
      errorMessages: [],
    }
    const queries = ErrorRAG.buildQueries(info)

    expect(queries.length).toBe(2)
    expect(queries[0]).toContain("http")
    expect(queries[1]).toContain("ListenAndServe")
  })

  it("limits to 3 queries max", () => {
    const info: ErrorRAG.ErrorInfo = {
      output: "",
      packages: ["http", "tls", "crypto"],
      symbols: ["Foo", "Bar", "Baz"],
      errorMessages: [],
    }
    const queries = ErrorRAG.buildQueries(info)

    expect(queries.length).toBeLessThanOrEqual(3)
  })

  it("limits packages to 2", () => {
    const info: ErrorRAG.ErrorInfo = {
      output: "",
      packages: ["http", "tls", "crypto", "net"],
      symbols: [],
      errorMessages: [],
    }
    const queries = ErrorRAG.buildQueries(info)

    // Should only have 2 package queries
    expect(queries.length).toBe(2)
  })

  it("returns empty for no info", () => {
    const info: ErrorRAG.ErrorInfo = {
      output: "",
      packages: [],
      symbols: [],
      errorMessages: [],
    }
    const queries = ErrorRAG.buildQueries(info)

    expect(queries.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Injection lifecycle (getInjection / clearInjection / clear)
// ---------------------------------------------------------------------------

describe("ErrorRAG injection lifecycle", () => {
  const testSession = "test-session-error-rag"

  it("getInjection returns undefined when no cache", () => {
    expect(ErrorRAG.getInjection(testSession)).toBeUndefined()
  })

  it("clear removes cached data", () => {
    // We can't directly set the cache, but clear should be safe to call
    ErrorRAG.clear(testSession)
    expect(ErrorRAG.getInjection(testSession)).toBeUndefined()
  })

  it("clearInjection removes cached data", () => {
    ErrorRAG.clearInjection(testSession)
    expect(ErrorRAG.getInjection(testSession)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// processToolResults (unit tests for filtering logic)
// ---------------------------------------------------------------------------

describe("ErrorRAG.processToolResults", () => {
  it("ignores non-bash tool parts", async () => {
    const parts = [
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", output: "undefined: foo" },
      },
    ]

    // Should not throw or cache anything
    await ErrorRAG.processToolResults("test-ignore", parts)
    expect(ErrorRAG.getInjection("test-ignore")).toBeUndefined()
    ErrorRAG.clear("test-ignore")
  })

  it("ignores bash parts with non-completed status", async () => {
    const parts = [
      {
        type: "tool",
        tool: "bash",
        state: { status: "running", output: "undefined: foo" },
      },
    ]

    await ErrorRAG.processToolResults("test-running", parts)
    expect(ErrorRAG.getInjection("test-running")).toBeUndefined()
    ErrorRAG.clear("test-running")
  })

  it("ignores bash parts without compilation errors", async () => {
    const parts = [
      {
        type: "tool",
        tool: "bash",
        state: { status: "completed", output: "Build successful\nAll tests passed" },
      },
    ]

    await ErrorRAG.processToolResults("test-success", parts)
    expect(ErrorRAG.getInjection("test-success")).toBeUndefined()
    ErrorRAG.clear("test-success")
  })

  it("ignores empty output", async () => {
    const parts = [
      {
        type: "tool",
        tool: "bash",
        state: { status: "completed", output: "" },
      },
    ]

    await ErrorRAG.processToolResults("test-empty", parts)
    expect(ErrorRAG.getInjection("test-empty")).toBeUndefined()
    ErrorRAG.clear("test-empty")
  })

  it("handles non-tool parts gracefully", async () => {
    const parts = [
      { type: "text" },
      { type: "file" },
    ]

    // Should not throw
    await ErrorRAG.processToolResults("test-nontool", parts as any)
    expect(ErrorRAG.getInjection("test-nontool")).toBeUndefined()
  })
})
