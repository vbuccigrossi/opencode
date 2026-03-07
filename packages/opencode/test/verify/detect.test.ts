import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { VerifyDetect } from "../../src/verify/detect"

describe("verify.detect", () => {
  function withTmpDir(fn: (dir: string) => void | Promise<void>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-detect-"))
    try {
      const result = fn(dir)
      if (result instanceof Promise) {
        return result.finally(() => fs.rmSync(dir, { recursive: true }))
      }
    } finally {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
    }
  }

  test("detects bun project with package.json", () => {
    withTmpDir((dir) => {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          scripts: { test: "bun test", typecheck: "tsc --noEmit" },
          devDependencies: { typescript: "^5.0.0" },
        }),
      )
      fs.writeFileSync(path.join(dir, "bun.lockb"), "")

      const cmds = VerifyDetect.detect(dir)
      expect(cmds.typecheck).toBe("bun run typecheck")
      expect(cmds.test).toBe("bun test")
    })
  })

  test("detects npm project", () => {
    withTmpDir((dir) => {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          scripts: { test: "jest", lint: "eslint ." },
        }),
      )

      const cmds = VerifyDetect.detect(dir)
      expect(cmds.test).toBe("npm run test")
      expect(cmds.lint).toBe("npm run lint")
    })
  })

  test("detects Go project", () => {
    withTmpDir((dir) => {
      fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n")

      const cmds = VerifyDetect.detect(dir)
      expect(cmds.typecheck).toBe("go vet ./...")
      expect(cmds.test).toBe("go test ./...")
      expect(cmds.build).toBe("go build ./...")
    })
  })

  test("detects Rust project", () => {
    withTmpDir((dir) => {
      fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "test"\n')

      const cmds = VerifyDetect.detect(dir)
      expect(cmds.typecheck).toBe("cargo check")
      expect(cmds.test).toBe("cargo test")
      expect(cmds.lint).toBe("cargo clippy")
      expect(cmds.build).toBe("cargo build")
    })
  })

  test("detects Python project with pytest", () => {
    withTmpDir((dir) => {
      fs.writeFileSync(path.join(dir, "pyproject.toml"), "[tool.pytest]\n")
      fs.mkdirSync(path.join(dir, "tests"))

      const cmds = VerifyDetect.detect(dir)
      expect(cmds.test).toBe("pytest")
      expect(cmds.typecheck).toBe("mypy .")
    })
  })

  test("returns empty for unknown project", () => {
    withTmpDir((dir) => {
      // Empty directory — no project manifest
      const cmds = VerifyDetect.detect(dir)
      expect(cmds.typecheck).toBeUndefined()
      expect(cmds.test).toBeUndefined()
      expect(cmds.lint).toBeUndefined()
      expect(cmds.build).toBeUndefined()
    })
  })

  test("detects pnpm from lockfile", () => {
    withTmpDir((dir) => {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }),
      )
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "")

      const cmds = VerifyDetect.detect(dir)
      expect(cmds.test).toBe("pnpm test")
    })
  })
})
