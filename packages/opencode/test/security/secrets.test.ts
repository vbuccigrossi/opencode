import { describe, expect, test } from "bun:test"
import { Secrets } from "../../src/security/secrets"

describe("secrets.shannonEntropy", () => {
  test("empty string has zero entropy", () => {
    expect(Secrets.shannonEntropy("")).toBe(0)
  })

  test("single repeated char has zero entropy", () => {
    expect(Secrets.shannonEntropy("aaaaaaa")).toBe(0)
  })

  test("high entropy string scores above 3", () => {
    // Random-looking string should have high entropy
    const entropy = Secrets.shannonEntropy("aB3$xZ9!kL7@mN2#")
    expect(entropy).toBeGreaterThan(3.0)
  })

  test("low entropy placeholder scores below 3", () => {
    const entropy = Secrets.shannonEntropy("xxxxxxxxxxxx")
    expect(entropy).toBeLessThan(1.0)
  })
})

describe("secrets.scanFile", () => {
  test("detects AWS access key", () => {
    const content = `const key = "AKIAIOSFODNN7EXAMPLE"`
    const findings = Secrets.scanFile(content, "config.ts")
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0].category).toBe("aws")
    expect(findings[0].severity).toBe("critical")
  })

  test("detects private key header", () => {
    const content = `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----`
    const findings = Secrets.scanFile(content, "cert.pem")
    expect(findings.some((f) => f.pattern === "private-key")).toBe(true)
  })

  test("detects postgres connection URL with credentials", () => {
    const content = `DATABASE_URL=postgres://admin:s3cr3t_p4ss@db.example.com:5432/mydb`
    const findings = Secrets.scanFile(content, "env.ts")
    expect(findings.some((f) => f.category === "database")).toBe(true)
  })

  test("detects GitHub token", () => {
    const content = `const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"`
    const findings = Secrets.scanFile(content, "auth.ts")
    expect(findings.some((f) => f.category === "github")).toBe(true)
  })

  test("detects JWT token", () => {
    const content = `const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"`
    const findings = Secrets.scanFile(content, "auth.ts")
    expect(findings.some((f) => f.pattern === "jwt-token")).toBe(true)
  })

  test("skips placeholder values", () => {
    const content = `api_key = "your-api-key-here"`
    const findings = Secrets.scanFile(content, "config.ts")
    expect(findings.length).toBe(0)
  })

  test("skips binary file extensions", () => {
    const content = `AKIAIOSFODNN7EXAMPLE`
    const findings = Secrets.scanFile(content, "image.png")
    expect(findings.length).toBe(0)
  })

  test("skips node_modules paths", () => {
    const content = `const key = "AKIAIOSFODNN7EXAMPLE"`
    const findings = Secrets.scanFile(content, "node_modules/pkg/config.ts")
    expect(findings.length).toBe(0)
  })

  test("filters by category", () => {
    const content = [
      `const key = "AKIAIOSFODNN7EXAMPLE"`,
      `const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"`,
    ].join("\n")
    const findings = Secrets.scanFile(content, "config.ts", { categories: ["auth"] })
    // Only JWT should match (auth category), not AWS
    expect(findings.every((f) => f.category === "auth")).toBe(true)
  })

  test("respects allowlist", () => {
    const content = `const key = "AKIAIOSFODNN7EXAMPLE"`
    const findings = Secrets.scanFile(content, "config.ts", { allowlist: ["AKIAIOSFODNN7EXAMPLE"] })
    expect(findings.length).toBe(0)
  })

  test("detects Stripe secret key pattern", () => {
    // Build the test key at runtime to avoid triggering GitHub secret scanning
    const key = ["sk", "test", "AABBCCDDEE1122334455AABB"].join("_")
    const content = `const stripe = require("stripe")("${key}")`
    const findings = Secrets.scanFile(content, "billing.ts")
    expect(findings.some((f) => f.pattern === "stripe-secret")).toBe(true)
  })

  test("detects Slack token", () => {
    const content = `const token = "xoxb-1234567890-abcdefghij"`
    const findings = Secrets.scanFile(content, "slack.ts")
    expect(findings.some((f) => f.category === "slack")).toBe(true)
  })
})

describe("secrets.format", () => {
  test("formats empty findings", () => {
    expect(Secrets.format([])).toBe("No secrets detected.")
  })

  test("formats findings with severity counts", () => {
    const findings: Secrets.Finding[] = [
      { file: "/app/config.ts", line: 5, column: 1, pattern: "aws-access-key", category: "aws", severity: "critical", snippet: "const key = ...", entropy: 3.5 },
      { file: "/app/auth.ts", line: 10, column: 1, pattern: "jwt-token", category: "auth", severity: "high", snippet: "const jwt = ...", entropy: 4.0 },
    ]
    const output = Secrets.format(findings, "/app")
    expect(output).toContain("2 potential secret(s)")
    expect(output).toContain("Critical: 1")
    expect(output).toContain("High: 1")
    expect(output).toContain("config.ts:5")
  })
})
