import { describe, expect, test } from "bun:test"
import { Graph } from "../../src/graph"

describe("graph.isTestFile", () => {
  // Suffix patterns
  test("detects .test.ts files", () => {
    expect(Graph.isTestFile("src/auth.test.ts")).toBe(true)
  })

  test("detects .spec.ts files", () => {
    expect(Graph.isTestFile("src/auth.spec.ts")).toBe(true)
  })

  test("detects .test.js files", () => {
    expect(Graph.isTestFile("lib/utils.test.js")).toBe(true)
  })

  test("detects .spec.jsx files", () => {
    expect(Graph.isTestFile("components/Button.spec.jsx")).toBe(true)
  })

  test("detects Go test files", () => {
    expect(Graph.isTestFile("pkg/handler/auth_test.go")).toBe(true)
  })

  test("detects Python test_ prefix", () => {
    expect(Graph.isTestFile("tests/test_auth.py")).toBe(true)
  })

  test("detects Python _test suffix", () => {
    expect(Graph.isTestFile("tests/auth_test.py")).toBe(true)
  })

  // Directory conventions
  test("detects files in test/ directory", () => {
    expect(Graph.isTestFile("test/helper.ts")).toBe(true)
  })

  test("detects files in tests/ directory", () => {
    expect(Graph.isTestFile("tests/fixtures/data.json")).toBe(true)
  })

  test("detects files in __tests__/ directory", () => {
    expect(Graph.isTestFile("src/__tests__/auth.ts")).toBe(true)
  })

  test("detects files in spec/ directory", () => {
    expect(Graph.isTestFile("spec/models/user_spec.rb")).toBe(true)
  })

  // False positives avoided
  test("does not match 'attestation.ts'", () => {
    expect(Graph.isTestFile("src/attestation.ts")).toBe(false)
  })

  test("does not match 'contest.ts'", () => {
    expect(Graph.isTestFile("src/contest.ts")).toBe(false)
  })

  test("does not match 'latest.ts'", () => {
    expect(Graph.isTestFile("src/latest.ts")).toBe(false)
  })

  test("does not match regular source file", () => {
    expect(Graph.isTestFile("src/auth/handler.ts")).toBe(false)
  })

  test("does not match 'testing-utils.ts' (no directory boundary)", () => {
    expect(Graph.isTestFile("src/testing-utils.ts")).toBe(false)
  })
})
