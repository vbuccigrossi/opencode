import { describe, expect, test } from "bun:test"
import { Scorer } from "../../src/context/scorer"

describe("context.scorer", () => {
  describe("extractSeeds", () => {
    test("extracts file paths from message", () => {
      const seeds = Scorer.extractSeeds("Please fix the bug in src/auth/login.ts")
      expect(seeds.filePaths).toContain("src/auth/login.ts")
    })

    test("extracts multiple file paths", () => {
      const seeds = Scorer.extractSeeds("Look at src/model.ts and lib/utils.py for the issue")
      expect(seeds.filePaths).toContain("src/model.ts")
      expect(seeds.filePaths).toContain("lib/utils.py")
    })

    test("extracts CamelCase identifiers as keywords", () => {
      const seeds = Scorer.extractSeeds("The UserService class has a bug in the login method")
      expect(seeds.keywords).toContain("UserService")
    })

    test("extracts backtick-quoted identifiers", () => {
      const seeds = Scorer.extractSeeds("The `processPayment` function is failing")
      expect(seeds.keywords).toContain("processPayment")
    })

    test("extracts function/class names from code-like patterns", () => {
      const seeds = Scorer.extractSeeds("Fix the function validateInput so it handles nulls")
      expect(seeds.keywords).toContain("validateInput")
    })

    test("ignores common English words", () => {
      const seeds = Scorer.extractSeeds("Please help me fix this bug")
      // "Please", "Help" should be filtered out as common words
      expect(seeds.keywords).not.toContain("Please")
      expect(seeds.keywords).not.toContain("Help")
    })

    test("deduplicates keywords", () => {
      const seeds = Scorer.extractSeeds("Call `MyService` and then MyService again")
      const count = seeds.keywords.filter((k) => k === "MyService").length
      expect(count).toBe(1)
    })

    test("preserves raw text", () => {
      const text = "Fix the UserService login method"
      const seeds = Scorer.extractSeeds(text)
      expect(seeds.rawText).toBe(text)
    })

    test("handles empty input", () => {
      const seeds = Scorer.extractSeeds("")
      expect(seeds.keywords).toHaveLength(0)
      expect(seeds.filePaths).toHaveLength(0)
    })

    test("extracts Go and Rust file paths", () => {
      const seeds = Scorer.extractSeeds("Check main.go and lib.rs for the implementation")
      expect(seeds.filePaths).toContain("main.go")
      expect(seeds.filePaths).toContain("lib.rs")
    })
  })
})
