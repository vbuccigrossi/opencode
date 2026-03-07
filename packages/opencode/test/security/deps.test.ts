import { describe, expect, test } from "bun:test"
import { DepAudit } from "../../src/security/deps"
import fs from "fs/promises"
import path from "path"
import os from "os"

describe("deps.detect", () => {
  test("detects npm project", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dep-test-"))
    try {
      await fs.writeFile(path.join(dir, "package.json"), "{}")
      await fs.writeFile(path.join(dir, "package-lock.json"), "{}")
      const results = await DepAudit.detect(dir)
      expect(results.some((r) => r.packageManager === "npm")).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("detects go project", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dep-test-"))
    try {
      await fs.writeFile(path.join(dir, "go.mod"), "module example.com/test")
      await fs.writeFile(path.join(dir, "go.sum"), "")
      const results = await DepAudit.detect(dir)
      expect(results.some((r) => r.packageManager === "go")).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("detects cargo project", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dep-test-"))
    try {
      await fs.writeFile(path.join(dir, "Cargo.toml"), "[package]")
      await fs.writeFile(path.join(dir, "Cargo.lock"), "")
      const results = await DepAudit.detect(dir)
      expect(results.some((r) => r.packageManager === "cargo")).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("detects pip project", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dep-test-"))
    try {
      await fs.writeFile(path.join(dir, "requirements.txt"), "flask==2.0.0")
      const results = await DepAudit.detect(dir)
      expect(results.some((r) => r.packageManager === "pip")).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("returns empty for unknown project", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dep-test-"))
    try {
      const results = await DepAudit.detect(dir)
      expect(results.length).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })

  test("bun takes priority over npm", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dep-test-"))
    try {
      await fs.writeFile(path.join(dir, "package.json"), "{}")
      await fs.writeFile(path.join(dir, "bun.lockb"), "")
      await fs.writeFile(path.join(dir, "package-lock.json"), "{}")
      const results = await DepAudit.detect(dir)
      expect(results.some((r) => r.packageManager === "bun")).toBe(true)
      expect(results.some((r) => r.packageManager === "npm")).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})

describe("deps.format", () => {
  test("formats empty results", () => {
    const results: DepAudit.AuditResult[] = [
      { packageManager: "npm", vulnerabilities: [], totalDeps: 50, scannedAt: Date.now() },
    ]
    const output = DepAudit.format(results)
    expect(output).toContain("npm")
    expect(output).toContain("50 dependencies")
    expect(output).toContain("No known vulnerabilities")
  })

  test("formats results with vulnerabilities", () => {
    const results: DepAudit.AuditResult[] = [
      {
        packageManager: "npm",
        totalDeps: 100,
        scannedAt: Date.now(),
        vulnerabilities: [
          {
            package: "lodash",
            version: "4.17.15",
            vulnerability: "Prototype Pollution",
            severity: "high",
            description: "Prototype pollution in lodash",
            fixedVersion: "4.17.21",
          },
        ],
      },
    ]
    const output = DepAudit.format(results)
    expect(output).toContain("lodash")
    expect(output).toContain("HIGH")
    expect(output).toContain("Prototype Pollution")
    expect(output).toContain("4.17.21")
  })

  test("formats error results", () => {
    const results: DepAudit.AuditResult[] = [
      { packageManager: "cargo", vulnerabilities: [], totalDeps: 0, scannedAt: Date.now(), error: "cargo-audit not available" },
    ]
    const output = DepAudit.format(results)
    expect(output).toContain("cargo-audit not available")
  })
})
