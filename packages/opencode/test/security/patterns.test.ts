import { describe, expect, test } from "bun:test"
import { SecurityPatterns } from "../../src/security/patterns"

describe("patterns.scanFile", () => {
  test("detects eval usage", () => {
    const content = `const result = eval(userInput)`
    const findings = SecurityPatterns.scanFile(content, "handler.ts")
    expect(findings.some((f) => f.title.includes("Eval"))).toBe(true)
    expect(findings.some((f) => f.severity === "critical")).toBe(true)
  })

  test("detects SQL injection via template literal", () => {
    const content = `db.query(\`SELECT * FROM users WHERE id = \${userId}\`)`
    const findings = SecurityPatterns.scanFile(content, "db.ts")
    expect(findings.some((f) => f.category === "injection")).toBe(true)
  })

  test("detects innerHTML assignment", () => {
    const content = `element.innerHTML = data`
    const findings = SecurityPatterns.scanFile(content, "render.ts")
    expect(findings.some((f) => f.title.includes("innerHTML"))).toBe(true)
  })

  test("detects dangerouslySetInnerHTML", () => {
    const content = `<div dangerouslySetInnerHTML={{ __html: content }} />`
    const findings = SecurityPatterns.scanFile(content, "component.tsx")
    expect(findings.some((f) => f.category === "xss")).toBe(true)
  })

  test("detects TLS cert validation disabled", () => {
    const content = `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"`
    const findings = SecurityPatterns.scanFile(content, "server.ts")
    expect(findings.some((f) => f.title.includes("TLS"))).toBe(true)
    expect(findings.some((f) => f.severity === "critical")).toBe(true)
  })

  test("detects permissive CORS", () => {
    const content = `Access-Control-Allow-Origin: "*"`
    const findings = SecurityPatterns.scanFile(content, "middleware.ts")
    expect(findings.some((f) => f.category === "auth")).toBe(true)
  })

  test("detects debug endpoint", () => {
    const content = `app.get("/debug/vars", handler)`
    const findings = SecurityPatterns.scanFile(content, "routes.ts")
    expect(findings.some((f) => f.title.includes("Debug"))).toBe(true)
  })

  test("detects permissive file permissions", () => {
    const content = `{ mode: 0o777 }`
    const findings = SecurityPatterns.scanFile(content, "setup.ts")
    expect(findings.some((f) => f.category === "misconfiguration")).toBe(true)
  })

  test("skips comment-only lines", () => {
    const content = `// eval(something)\n// This is just a comment`
    const findings = SecurityPatterns.scanFile(content, "code.ts")
    expect(findings.length).toBe(0)
  })

  test("skips binary extensions", () => {
    const content = `eval(something)`
    const findings = SecurityPatterns.scanFile(content, "file.png")
    expect(findings.length).toBe(0)
  })

  test("respects extension filtering", () => {
    // Python-specific pattern shouldn't match in .ts files
    const content = `os.system(f"rm {path}")`
    const findings = SecurityPatterns.scanFile(content, "script.py")
    expect(findings.some((f) => f.title.includes("Python"))).toBe(true)
  })

  test("suppression pattern works for debug mode", () => {
    // If "test" or "development" appears within 3 lines, suppress debug mode finding
    const content = `// development config\nconst env = "dev"\nDEBUG = true`
    const findings = SecurityPatterns.scanFile(content, "config.ts")
    const debugFindings = findings.filter((f) => f.title.includes("Debug Mode"))
    expect(debugFindings.length).toBe(0)
  })

  test("filters by category", () => {
    const content = [
      `eval(input)`,
      `element.innerHTML = data`,
      `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"`,
    ].join("\n")
    const findings = SecurityPatterns.scanFile(content, "code.ts", { categories: ["xss"] })
    expect(findings.every((f) => f.category === "xss")).toBe(true)
  })
})

describe("patterns.format", () => {
  test("formats empty findings", () => {
    expect(SecurityPatterns.format([])).toBe("No security pattern issues detected.")
  })

  test("formats findings grouped by category", () => {
    const findings: SecurityPatterns.Finding[] = [
      {
        file: "/app/code.ts",
        line: 5,
        category: "injection",
        severity: "critical",
        title: "Eval Usage",
        description: "eval() is dangerous",
        snippet: "eval(input)",
        remediation: "Avoid eval",
      },
    ]
    const output = SecurityPatterns.format(findings, "/app")
    expect(output).toContain("1 security pattern issue(s)")
    expect(output).toContain("INJECTION")
    expect(output).toContain("Eval Usage")
  })
})

describe("patterns.categories", () => {
  test("returns all unique categories", () => {
    const cats = SecurityPatterns.categories()
    expect(cats).toContain("injection")
    expect(cats).toContain("xss")
    expect(cats).toContain("crypto")
    expect(cats).toContain("misconfiguration")
  })
})
