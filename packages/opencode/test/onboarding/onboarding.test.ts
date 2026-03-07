import { describe, expect, test, beforeEach } from "bun:test"
import { Onboarding } from "../../src/onboarding"
import { Detector } from "../../src/onboarding/detector"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"

/** Create a temporary project directory with specified files. */
function createProject(
  files: Record<string, string>,
  dirs?: string[],
): string {
  const dir = join(tmpdir(), `onboard-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })

  for (const d of dirs ?? []) {
    mkdirSync(join(dir, d), { recursive: true })
  }

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path)
    mkdirSync(join(fullPath, ".."), { recursive: true })
    writeFileSync(fullPath, content)
  }

  return dir
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true })
  } catch {}
}

describe("Detector", () => {
  test("detects TypeScript from package.json", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "test-project",
        dependencies: {},
        devDependencies: { typescript: "^5.0.0" },
      }),
    })

    const result = await Detector.detect(dir)
    expect(result.language).toBe("TypeScript")
    cleanup(dir)
  })

  test("detects JavaScript without typescript dep", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "js-project",
        dependencies: { express: "^4.0.0" },
      }),
    })

    const result = await Detector.detect(dir)
    expect(result.language).toBe("JavaScript")
    expect(result.framework).toBe("Express")
    cleanup(dir)
  })

  test("detects React framework", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "react-app",
        dependencies: { react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0" },
      }),
    })

    const result = await Detector.detect(dir)
    expect(result.framework).toBe("React")
    expect(result.testFramework).toBe("vitest")
    cleanup(dir)
  })

  test("detects Next.js framework", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "next-app",
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    })

    const result = await Detector.detect(dir)
    expect(result.framework).toBe("Next.js")
    cleanup(dir)
  })

  test("detects Go project", async () => {
    const dir = createProject({
      "go.mod": "module github.com/user/myproject\n\ngo 1.21\n",
    })

    const result = await Detector.detect(dir)
    expect(result.language).toBe("Go")
    expect(result.buildTool).toBe("go")
    expect(result.testFramework).toBe("go test")
    cleanup(dir)
  })

  test("detects Rust project", async () => {
    const dir = createProject({
      "Cargo.toml": '[package]\nname = "my-crate"\nversion = "0.1.0"\n',
    })

    const result = await Detector.detect(dir)
    expect(result.language).toBe("Rust")
    expect(result.buildTool).toBe("cargo")
    cleanup(dir)
  })

  test("detects Python project from pyproject.toml", async () => {
    const dir = createProject({
      "pyproject.toml": "[tool.poetry]\nname = 'myapp'\n\n[tool.pytest]\n",
    })

    const result = await Detector.detect(dir)
    expect(result.language).toBe("Python")
    expect(result.testFramework).toBe("pytest")
    cleanup(dir)
  })

  test("detects bun package manager from lockfile", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "bun-project",
        devDependencies: { typescript: "^5.0.0" },
      }),
      "bun.lock": "# bun lockfile",
    })

    const result = await Detector.detect(dir)
    expect(result.packageManager).toBe("bun")
    cleanup(dir)
  })

  test("detects npm package manager from lockfile", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "npm-project",
        dependencies: {},
      }),
      "package-lock.json": "{}",
    })

    const result = await Detector.detect(dir)
    expect(result.packageManager).toBe("npm")
    cleanup(dir)
  })

  test("detects build tools", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "vite-project",
        dependencies: {},
        devDependencies: { typescript: "^5.0.0", vite: "^5.0.0", jest: "^29.0.0" },
      }),
    })

    const result = await Detector.detect(dir)
    expect(result.buildTool).toBe("vite")
    expect(result.testFramework).toBe("jest")
    cleanup(dir)
  })

  test("returns unknown for empty directory", async () => {
    const dir = createProject({})
    const result = await Detector.detect(dir)
    expect(result.language).toBe("Unknown")
    cleanup(dir)
  })
})

describe("Onboarding", () => {
  beforeEach(() => {
    Onboarding.clearAll()
  })

  test("runs onboarding and builds model", async () => {
    const dir = createProject(
      {
        "package.json": JSON.stringify({
          name: "test-app",
          dependencies: { react: "^18.0.0" },
          devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0" },
        }),
        "bun.lock": "# bun lockfile",
        "README.md": "# Test App\n\nA sample React application for testing.",
        "src/index.ts": 'export function main() { console.log("hello") }',
        "src/utils.ts": 'export function add(a: number, b: number) { return a + b }',
      },
      ["src", "test", "public"],
    )

    const model = await Onboarding.run(dir)

    expect(model.name).toBe("test-app")
    expect(model.language).toBe("TypeScript")
    expect(model.framework).toBe("React")
    expect(model.testFramework).toBe("vitest")
    expect(model.packageManager).toBe("bun")
    expect(model.entryPoints).toContain("src/index.ts")
    expect(model.keyDirectories.some((d) => d.path === "src")).toBe(true)
    expect(model.keyDirectories.some((d) => d.path === "test")).toBe(true)
    expect(model.architecture).toContain("sample React application")

    cleanup(dir)
  })

  test("isOnboarded returns false before run", () => {
    expect(Onboarding.isOnboarded("/nonexistent")).toBe(false)
  })

  test("isOnboarded returns true after run", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({ name: "x" }),
    })

    await Onboarding.run(dir)
    expect(Onboarding.isOnboarded(dir)).toBe(true)

    cleanup(dir)
  })

  test("getModel returns model after run", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({ name: "model-test" }),
    })

    await Onboarding.run(dir)
    const model = Onboarding.getModel(dir)
    expect(model).toBeDefined()
    expect(model!.name).toBe("model-test")

    cleanup(dir)
  })

  test("getModel returns undefined before run", () => {
    expect(Onboarding.getModel("/nonexistent")).toBeUndefined()
  })

  test("format produces project-model block", async () => {
    const dir = createProject(
      {
        "package.json": JSON.stringify({
          name: "fmt-test",
          devDependencies: { typescript: "^5.0.0" },
        }),
        "src/index.ts": 'export const x = 1;',
      },
      ["src", "test"],
    )

    const model = await Onboarding.run(dir)
    const formatted = Onboarding.format(model)

    expect(formatted).toContain("<project-model>")
    expect(formatted).toContain("</project-model>")
    expect(formatted).toContain("fmt-test")
    expect(formatted).toContain("TypeScript")

    cleanup(dir)
  })

  test("detects conventions from source files", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "conv-test",
        devDependencies: { typescript: "^5.0.0" },
      }),
      "src/my-component.ts": `export namespace MyComponent {\n  export function render() {\n    return "hello";\n  }\n}\n`,
      "src/another-file.ts": `export namespace AnotherFile {\n  export const VALUE = 42;\n}\n`,
    }, ["src"])

    const model = await Onboarding.run(dir)

    // Should detect namespaces and semicolons
    expect(model.conventions.some((c) => c.includes("namespace"))).toBe(true)
    expect(model.conventions.some((c) => c.includes("semicolons") || c.includes("Semicolons"))).toBe(true)

    cleanup(dir)
  })

  test("detects Go entry points", async () => {
    const dir = createProject({
      "go.mod": "module mymod\n\ngo 1.21",
      "main.go": "package main\n\nfunc main() {}",
    })

    const model = await Onboarding.run(dir)
    expect(model.language).toBe("Go")
    expect(model.entryPoints).toContain("main.go")

    cleanup(dir)
  })

  test("detects Python entry points", async () => {
    const dir = createProject({
      "pyproject.toml": "[project]\nname = 'myapp'",
      "main.py": "if __name__ == '__main__': pass",
    })

    const model = await Onboarding.run(dir)
    expect(model.language).toBe("Python")
    expect(model.entryPoints).toContain("main.py")

    cleanup(dir)
  })

  test("generates fallback architecture without README", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({
        name: "no-readme",
        dependencies: { express: "^4.0.0" },
      }),
    })

    const model = await Onboarding.run(dir)
    expect(model.architecture).toContain("no-readme")
    expect(model.architecture).toContain("JavaScript")

    cleanup(dir)
  })

  test("clear removes model", async () => {
    const dir = createProject({
      "package.json": JSON.stringify({ name: "clear-test" }),
    })

    await Onboarding.run(dir)
    expect(Onboarding.isOnboarded(dir)).toBe(true)

    Onboarding.clear(dir)
    expect(Onboarding.isOnboarded(dir)).toBe(false)

    cleanup(dir)
  })

  test("completes in under 3 seconds", async () => {
    const dir = createProject(
      {
        "package.json": JSON.stringify({
          name: "perf-test",
          devDependencies: { typescript: "^5.0.0" },
        }),
        "README.md": "# Perf Test\n\nA quick project.",
        "src/index.ts": "export const x = 1",
      },
      ["src"],
    )

    const start = Date.now()
    await Onboarding.run(dir)
    const duration = Date.now() - start

    expect(duration).toBeLessThan(3000)

    cleanup(dir)
  })
})
