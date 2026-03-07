import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { VerifyDetect } from "../../src/verify/detect"

describe("verify.targeting", () => {
  function withTmpDir(fn: (dir: string) => void | Promise<void>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-target-"))
    try {
      const result = fn(dir)
      if (result instanceof Promise) {
        return result.finally(() => fs.rmSync(dir, { recursive: true }))
      }
    } finally {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
    }
  }

  describe("detectProjectType", () => {
    test("detects Node project", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "package.json"), "{}")
        expect(VerifyDetect.detectProjectType(dir)).toBe("node")
      })
    })

    test("detects Go project", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "go.mod"), "module example.com\n")
        expect(VerifyDetect.detectProjectType(dir)).toBe("go")
      })
    })

    test("detects Rust project", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n")
        expect(VerifyDetect.detectProjectType(dir)).toBe("rust")
      })
    })

    test("detects Python project", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "pyproject.toml"), "[tool.pytest]\n")
        expect(VerifyDetect.detectProjectType(dir)).toBe("python")
      })
    })

    test("returns unknown for empty directory", () => {
      withTmpDir((dir) => {
        expect(VerifyDetect.detectProjectType(dir)).toBe("unknown")
      })
    })
  })

  describe("targetingSupport", () => {
    test("Node without tsgo has no typecheck targeting", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }))
        const support = VerifyDetect.targetingSupport(dir)
        expect(support.typecheck).toBe(false)
        expect(support.test).toBe(true)
      })
    })

    test("Node with tsgo has typecheck targeting", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsgo --noEmit" } }))
        const support = VerifyDetect.targetingSupport(dir)
        expect(support.typecheck).toBe(true)
      })
    })

    test("Go has typecheck and test targeting", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "go.mod"), "module example.com\n")
        const support = VerifyDetect.targetingSupport(dir)
        expect(support.typecheck).toBe(true)
        expect(support.test).toBe(true)
        expect(support.build).toBe(true)
      })
    })

    test("Python has typecheck and test targeting", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "pyproject.toml"), "")
        const support = VerifyDetect.targetingSupport(dir)
        expect(support.typecheck).toBe(true)
        expect(support.test).toBe(true)
        expect(support.lint).toBe(true)
      })
    })

    test("Rust has no per-file targeting", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n")
        const support = VerifyDetect.targetingSupport(dir)
        expect(support.typecheck).toBe(false)
        expect(support.test).toBe(false)
      })
    })
  })

  describe("buildTargetedCommand", () => {
    test("Go typecheck targets package directories", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "go.mod"), "module example.com\n")
        const cmd = VerifyDetect.buildTargetedCommand(
          "go vet ./...",
          "typecheck",
          ["pkg/handler/main.go", "pkg/handler/util.go", "pkg/model/user.go"],
          dir,
        )
        expect(cmd).toContain("./pkg/handler")
        expect(cmd).toContain("./pkg/model")
        expect(cmd).not.toContain("./...")
      })
    })

    test("Python typecheck targets specific files", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "pyproject.toml"), "")
        const cmd = VerifyDetect.buildTargetedCommand(
          "mypy .",
          "typecheck",
          ["src/main.py", "src/utils.py"],
          dir,
        )
        expect(cmd).toBe("mypy src/main.py src/utils.py")
      })
    })

    test("Node tsgo typecheck appends files", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsgo --noEmit" } }))
        const cmd = VerifyDetect.buildTargetedCommand(
          "bun run typecheck",
          "typecheck",
          ["src/foo.ts"],
          dir,
        )
        expect(cmd).toBe("bun run typecheck src/foo.ts")
      })
    })

    test("returns original command when no files", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "go.mod"), "module example.com\n")
        const cmd = VerifyDetect.buildTargetedCommand("go vet ./...", "typecheck", [], dir)
        expect(cmd).toBe("go vet ./...")
      })
    })

    test("returns original command for unsupported targeting", () => {
      withTmpDir((dir) => {
        fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n")
        const cmd = VerifyDetect.buildTargetedCommand("cargo check", "typecheck", ["src/main.rs"], dir)
        expect(cmd).toBe("cargo check")
      })
    })
  })
})
