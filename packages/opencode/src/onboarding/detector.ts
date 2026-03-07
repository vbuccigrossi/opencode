import { Log } from "@/util/log"
import { readFile, access } from "fs/promises"
import { join } from "path"

/**
 * Language and framework detection for project onboarding.
 *
 * Detects the primary language, framework, build tool, and test
 * framework by inspecting manifest files and directory structure.
 */
export namespace Detector {
  const log = Log.create({ service: "onboarding.detector" })

  /** Detection result. */
  export interface Detection {
    language: string
    framework?: string
    buildTool: string
    testFramework?: string
    packageManager?: string
  }

  /** Manifest file patterns and what they indicate. */
  const MANIFESTS: Array<{
    file: string
    language: string
    detect: (content: string) => Partial<Detection>
  }> = [
    {
      file: "package.json",
      language: "TypeScript",
      detect: (content) => {
        const pkg = JSON.parse(content)
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        const detection: Partial<Detection> = {}

        // Language
        if (deps.typescript || deps["@types/node"]) {
          detection.language = "TypeScript"
        } else {
          detection.language = "JavaScript"
        }

        // Framework
        if (deps.next || deps["next"]) detection.framework = "Next.js"
        else if (deps.react) detection.framework = "React"
        else if (deps.vue) detection.framework = "Vue"
        else if (deps.svelte || deps["@sveltejs/kit"]) detection.framework = "Svelte"
        else if (deps.express) detection.framework = "Express"
        else if (deps.fastify) detection.framework = "Fastify"
        else if (deps.hono) detection.framework = "Hono"
        else if (deps["@nestjs/core"]) detection.framework = "NestJS"
        else if (deps.astro) detection.framework = "Astro"
        else if (deps.nuxt) detection.framework = "Nuxt"
        else if (deps.angular || deps["@angular/core"]) detection.framework = "Angular"
        else if (deps.remix || deps["@remix-run/react"]) detection.framework = "Remix"
        else if (deps.elysia) detection.framework = "Elysia"

        // Build tool
        if (deps.turbo || deps["turbo"]) detection.buildTool = "turbo"
        else if (deps.vite) detection.buildTool = "vite"
        else if (deps.webpack) detection.buildTool = "webpack"
        else if (deps.esbuild) detection.buildTool = "esbuild"
        else if (deps.rollup) detection.buildTool = "rollup"
        else if (deps.tsup) detection.buildTool = "tsup"
        else if (pkg.scripts?.build) detection.buildTool = "npm scripts"

        // Test framework
        if (deps.vitest) detection.testFramework = "vitest"
        else if (deps.jest || deps["ts-jest"]) detection.testFramework = "jest"
        else if (deps.mocha) detection.testFramework = "mocha"
        else if (deps["@testing-library/react"]) detection.testFramework = "testing-library"
        else if (deps.playwright || deps["@playwright/test"]) detection.testFramework = "playwright"

        // Package manager (from lockfile detection in run())
        return detection
      },
    },
    {
      file: "Cargo.toml",
      language: "Rust",
      detect: (content) => ({
        language: "Rust",
        buildTool: "cargo",
        testFramework: "cargo test",
      }),
    },
    {
      file: "go.mod",
      language: "Go",
      detect: (content) => {
        const detection: Partial<Detection> = {
          language: "Go",
          buildTool: "go",
          testFramework: "go test",
        }
        // Detect web frameworks
        if (content.includes("github.com/gin-gonic/gin")) detection.framework = "Gin"
        else if (content.includes("github.com/gofiber/fiber")) detection.framework = "Fiber"
        else if (content.includes("github.com/labstack/echo")) detection.framework = "Echo"
        return detection
      },
    },
    {
      file: "pyproject.toml",
      language: "Python",
      detect: (content) => {
        const detection: Partial<Detection> = {
          language: "Python",
          buildTool: "pip",
        }
        if (content.includes("django")) detection.framework = "Django"
        else if (content.includes("fastapi")) detection.framework = "FastAPI"
        else if (content.includes("flask")) detection.framework = "Flask"

        if (content.includes("pytest")) detection.testFramework = "pytest"
        if (content.includes("poetry")) detection.buildTool = "poetry"
        else if (content.includes("hatch")) detection.buildTool = "hatch"
        else if (content.includes("setuptools")) detection.buildTool = "setuptools"

        return detection
      },
    },
    {
      file: "requirements.txt",
      language: "Python",
      detect: (content) => {
        const detection: Partial<Detection> = {
          language: "Python",
          buildTool: "pip",
        }
        if (content.includes("django")) detection.framework = "Django"
        else if (content.includes("fastapi")) detection.framework = "FastAPI"
        else if (content.includes("flask")) detection.framework = "Flask"
        if (content.includes("pytest")) detection.testFramework = "pytest"
        return detection
      },
    },
  ]

  /**
   * Detect project language, framework, build tool, and test framework.
   *
   * @param cwd - Project root directory
   * @returns Detection result
   */
  export async function detect(cwd: string): Promise<Detection> {
    const result: Detection = {
      language: "Unknown",
      buildTool: "unknown",
    }

    for (const manifest of MANIFESTS) {
      try {
        const content = await readFile(join(cwd, manifest.file), "utf-8")
        const detected = manifest.detect(content)
        Object.assign(result, detected)
        break // Use first matching manifest
      } catch {
        // File doesn't exist — try next
      }
    }

    // Detect package manager from lockfiles
    result.packageManager = await detectPackageManager(cwd)
    if (result.packageManager === "bun" && !result.buildTool) {
      result.buildTool = "bun"
    }

    return result
  }

  /**
   * Detect package manager from lockfile presence.
   */
  async function detectPackageManager(cwd: string): Promise<string | undefined> {
    const lockfiles: Array<[string, string]> = [
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      ["Cargo.lock", "cargo"],
      ["go.sum", "go"],
      ["poetry.lock", "poetry"],
      ["Pipfile.lock", "pipenv"],
    ]

    for (const [file, manager] of lockfiles) {
      try {
        await access(join(cwd, file))
        return manager
      } catch {
        // Not found
      }
    }

    return undefined
  }
}
