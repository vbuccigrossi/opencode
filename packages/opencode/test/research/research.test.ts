import { describe, test, expect } from "bun:test"
import { Research } from "../../src/research"

describe("Research", () => {
  describe("errorLookup", () => {
    test("builds search URLs for a generic error", () => {
      const result = Research.errorLookup("Cannot find module 'foo'")
      expect(result.query).toContain("Cannot find module")
      expect(result.urls.length).toBeGreaterThanOrEqual(2)
      expect(result.urls.some((u) => u.includes("stackoverflow.com"))).toBe(true)
      expect(result.urls.some((u) => u.includes("github.com"))).toBe(true)
    })

    test("adds context to query", () => {
      const result = Research.errorLookup("ENOENT", "node.js")
      expect(result.query).toContain("ENOENT")
      expect(result.query).toContain("node.js")
    })

    test("detects TypeScript error codes", () => {
      const result = Research.errorLookup("error TS2345: Argument of type 'string' is not assignable")
      expect(result.urls.some((u) => u.includes("TS2345"))).toBe(true)
    })

    test("detects Rust error codes", () => {
      const result = Research.errorLookup("error[E0308]: mismatched types")
      expect(result.urls.some((u) => u.includes("E0308"))).toBe(true)
      expect(result.urls.some((u) => u.includes("doc.rust-lang.org"))).toBe(true)
    })

    test("cleans stack trace locations from error", () => {
      const result = Research.errorLookup("TypeError: undefined is not a function at /home/user/app/index.js:42:10")
      expect(result.query).not.toContain("/home/user")
      expect(result.query).not.toContain(":42:10")
    })

    test("truncates long error messages", () => {
      const longError = "A".repeat(500)
      const result = Research.errorLookup(longError)
      expect(result.query.length).toBeLessThanOrEqual(200)
    })
  })

  describe("changelogUrl", () => {
    test("returns npm changelog URLs", () => {
      const urls = Research.changelogUrl("react", "npm")
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.some((u) => u.includes("npmjs.com"))).toBe(true)
    })

    test("returns pypi changelog URLs", () => {
      const urls = Research.changelogUrl("flask", "pypi")
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.some((u) => u.includes("pypi.org"))).toBe(true)
    })

    test("returns crates changelog URLs", () => {
      const urls = Research.changelogUrl("serde", "crates")
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.some((u) => u.includes("crates.io"))).toBe(true)
    })
  })

  describe("compare", () => {
    test("builds comparison query", () => {
      const result = Research.compare("react", "vue")
      expect(result.query).toContain("react vs vue")
      expect(result.urls.length).toBeGreaterThan(0)
    })

    test("includes npmtrends URL", () => {
      const result = Research.compare("express", "fastify")
      expect(result.urls.some((u) => u.includes("npmtrends.com"))).toBe(true)
      expect(result.urls.some((u) => u.includes("express-vs-fastify") || u.includes("express") && u.includes("fastify"))).toBe(true)
    })

    test("adds context to query", () => {
      const result = Research.compare("webpack", "vite", "build tool")
      expect(result.query).toContain("build tool")
    })
  })

  describe("snippetSearch", () => {
    test("builds snippet search query", () => {
      const result = Research.snippetSearch("Array.from")
      expect(result.query).toContain("Array.from")
      expect(result.query).toContain("example")
    })

    test("includes language in query", () => {
      const result = Research.snippetSearch("map", "python")
      expect(result.query).toContain("python")
      expect(result.urls.some((u) => u.includes("github.com"))).toBe(true)
    })

    test("defaults to typescript for GitHub search", () => {
      const result = Research.snippetSearch("Promise.all")
      expect(result.urls.some((u) => u.includes("typescript"))).toBe(true)
    })
  })

  describe("formatDoc", () => {
    test("formats basic doc result", () => {
      const formatted = Research.formatDoc({
        package: "lodash",
        description: "Utility library",
      })
      expect(formatted).toContain("lodash")
      expect(formatted).toContain("Utility library")
    })

    test("includes version when available", () => {
      const formatted = Research.formatDoc({
        package: "express",
        version: "4.18.2",
        description: "Web framework",
      })
      expect(formatted).toContain("v4.18.2")
    })

    test("includes homepage and repository", () => {
      const formatted = Research.formatDoc({
        package: "react",
        description: "UI library",
        homepage: "https://reactjs.org",
        repository: "https://github.com/facebook/react",
      })
      expect(formatted).toContain("https://reactjs.org")
      expect(formatted).toContain("https://github.com/facebook/react")
    })

    test("includes keywords", () => {
      const formatted = Research.formatDoc({
        package: "zod",
        description: "TypeScript schema validation",
        keywords: ["typescript", "schema", "validation"],
      })
      expect(formatted).toContain("typescript")
      expect(formatted).toContain("validation")
    })

    test("truncates long readme", () => {
      const formatted = Research.formatDoc({
        package: "test",
        description: "test",
        readme: "A".repeat(5000),
      })
      // formatDoc truncates readme to 2000 chars
      expect(formatted.length).toBeLessThan(5000)
    })
  })

  describe("formatResults", () => {
    test("formats empty results", () => {
      const formatted = Research.formatResults([])
      expect(formatted).toBe("No results found.")
    })

    test("formats search results", () => {
      const formatted = Research.formatResults([
        {
          title: "How to fix ENOENT",
          url: "https://stackoverflow.com/q/123",
          snippet: "Use fs.existsSync to check first",
          source: "stackoverflow",
        },
        {
          title: "ENOENT error in Node.js",
          url: "https://github.com/issues/456",
          snippet: "This is a common issue when...",
          source: "github",
        },
      ])
      expect(formatted).toContain("1.")
      expect(formatted).toContain("2.")
      expect(formatted).toContain("[stackoverflow]")
      expect(formatted).toContain("[github]")
      expect(formatted).toContain("How to fix ENOENT")
    })
  })

  describe("docs (network)", () => {
    test("fetches npm package docs", async () => {
      // This test hits the network — it verifies the npm fetcher works
      const doc = await Research.docs("zod", "npm")
      expect(doc.package).toBe("zod")
      expect(doc.version).toBeTruthy()
      expect(doc.description).toBeTruthy()
    }, 15000)

    test("handles non-existent npm package", async () => {
      const doc = await Research.docs("this-package-definitely-does-not-exist-xyz-12345", "npm")
      expect(doc.package).toBe("this-package-definitely-does-not-exist-xyz-12345")
      expect(doc.description).toContain("Failed to fetch")
    }, 15000)

    test("returns go package stub", async () => {
      const doc = await Research.docs("fmt", "go")
      expect(doc.package).toBe("fmt")
      expect(doc.description).toContain("Go package")
      expect(doc.homepage).toContain("pkg.go.dev")
    })
  })
})
