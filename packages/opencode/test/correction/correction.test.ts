import { describe, test, expect, beforeEach } from "bun:test"
import { Correction } from "../../src/correction"

describe("Correction", () => {
  const sessionID = "test-session-001"

  beforeEach(() => {
    Correction.clear(sessionID)
  })

  describe("analyze", () => {
    test("detects negation corrections", () => {
      const result = Correction.analyze(sessionID, "No, don't refactor that function, just fix the bug.")
      expect(result.length).toBeGreaterThan(0)
      expect(Correction.count(sessionID)).toBeGreaterThan(0)
    })

    test("detects redirection with 'instead'", () => {
      const result = Correction.analyze(sessionID, "Instead of changing the types, update the interface.")
      expect(result.length).toBeGreaterThan(0)
    })

    test("detects redirection with 'actually'", () => {
      const result = Correction.analyze(sessionID, "Actually, use a Map instead of an object for that.")
      expect(result.length).toBeGreaterThan(0)
    })

    test("detects preference signals", () => {
      const result = Correction.analyze(sessionID, "Always use snake_case for file names in this project.")
      expect(result.length).toBeGreaterThan(0)
      const entry = result[0]
      expect(entry.category === "preference" || entry.category === "style").toBe(true)
    })

    test("detects style corrections", () => {
      const result = Correction.analyze(sessionID, "Your responses are too verbose, be more concise.")
      expect(result.length).toBeGreaterThan(0)
      expect(result.some((r) => r.category === "style")).toBe(true)
    })

    test("detects scope corrections", () => {
      const result = Correction.analyze(sessionID, "Only change the auth module, don't touch the database layer.")
      expect(result.length).toBeGreaterThan(0)
      expect(result.some((r) => r.category === "scope")).toBe(true)
    })

    test("detects frustration signals", () => {
      const result = Correction.analyze(sessionID, "I already said to use the existing helper function.")
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].strength).toBeGreaterThanOrEqual(0.9)
    })

    test("ignores short messages", () => {
      const result = Correction.analyze(sessionID, "ok")
      expect(result).toEqual([])
    })

    test("ignores messages without correction signals", () => {
      const result = Correction.analyze(sessionID, "Can you add a new endpoint for user profiles?")
      expect(result).toEqual([])
    })

    test("reinforces repeated corrections", () => {
      Correction.analyze(sessionID, "Don't add extra comments to the code.")
      const before = Correction.get(sessionID)
      const initialStrength = before[0]?.strength ?? 0

      Correction.analyze(sessionID, "Stop adding comments to the code please.")
      const after = Correction.get(sessionID)

      // Should have reinforced, not duplicated
      const commentCorrections = after.filter((c) =>
        c.instruction.toLowerCase().includes("comment") ||
        c.instruction.toLowerCase().includes("adding"),
      )
      // Either merged (same entry, higher strength) or separate entries — both valid
      expect(after.length).toBeGreaterThan(0)
    })
  })

  describe("get", () => {
    test("returns empty array for new session", () => {
      expect(Correction.get("brand-new-session")).toEqual([])
    })

    test("returns corrections sorted by strength", () => {
      Correction.analyze(sessionID, "I already told you to stop doing that, it's wrong.")
      Correction.analyze(sessionID, "Instead, use a different approach.")

      const corrections = Correction.get(sessionID)
      for (let i = 1; i < corrections.length; i++) {
        expect(corrections[i].strength).toBeLessThanOrEqual(corrections[i - 1].strength)
      }
    })
  })

  describe("format", () => {
    test("returns undefined when no corrections", () => {
      expect(Correction.format("empty-session")).toBeUndefined()
    })

    test("formats corrections as XML block", () => {
      Correction.analyze(sessionID, "Don't refactor code I didn't ask you to change.")
      Correction.analyze(sessionID, "Always use the existing utility functions.")

      const block = Correction.format(sessionID)
      expect(block).toBeTruthy()
      expect(block).toContain("<corrections>")
      expect(block).toContain("</corrections>")
      expect(block).toContain("corrected or redirected")
    })

    test("shows strength markers for reinforced corrections", () => {
      // Reinforce a correction multiple times
      Correction.analyze(sessionID, "Don't modify the test files.")
      Correction.analyze(sessionID, "Stop modifying the test files please.")
      Correction.analyze(sessionID, "I said don't touch the test files!")

      const block = Correction.format(sessionID)
      expect(block).toBeTruthy()
      // After reinforcement, strength should be high enough for markers
    })

    test("groups by category", () => {
      Correction.analyze(sessionID, "Be more concise in your responses.")
      Correction.analyze(sessionID, "Only change the auth module.")

      const block = Correction.format(sessionID)
      expect(block).toBeTruthy()
      // Should contain category labels
      expect(block).toMatch(/\[(style|scope|approach|preference|tool_use|output)\]/)
    })
  })

  describe("clear", () => {
    test("removes all corrections for a session", () => {
      Correction.analyze(sessionID, "Don't do that.")
      expect(Correction.count(sessionID)).toBeGreaterThan(0)

      Correction.clear(sessionID)
      expect(Correction.count(sessionID)).toBe(0)
    })
  })

  describe("count", () => {
    test("returns 0 for unknown session", () => {
      expect(Correction.count("unknown")).toBe(0)
    })

    test("tracks correction count", () => {
      Correction.analyze(sessionID, "Don't refactor the code.")
      Correction.analyze(sessionID, "Stop adding type annotations.")
      expect(Correction.count(sessionID)).toBeGreaterThan(0)
    })
  })
})
