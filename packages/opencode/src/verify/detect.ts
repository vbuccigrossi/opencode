import fs from "fs"
import path from "path"
import { Log } from "@/util/log"

/**
 * Auto-detects verification commands for a project by inspecting
 * package manifests (package.json, Cargo.toml, pyproject.toml, go.mod).
 */
export namespace VerifyDetect {
  const log = Log.create({ service: "verify.detect" })

  /** Detected verification commands for a project. */
  export interface Commands {
    typecheck?: string
    test?: string
    lint?: string
    build?: string
  }

  /** Whether targeted (per-file) verification is supported per step. */
  export interface TargetingSupport {
    typecheck: boolean
    test: boolean
    lint: boolean
    build: boolean
  }

  /** Project type identifier for targeted command construction. */
  export type ProjectType = "node" | "go" | "rust" | "python" | "unknown"

  /**
   * Auto-detects verification commands by inspecting the project root.
   *
   * Checks for package.json, Cargo.toml, pyproject.toml, go.mod in order.
   * Returns the first matching project type's commands.
   *
   * @param directory - Project root directory
   * @returns Detected commands, or empty if no project manifest found
   */
  export function detect(directory: string): Commands {
    // Node/Bun projects
    const pkgJsonPath = path.join(directory, "package.json")
    if (fs.existsSync(pkgJsonPath)) {
      return detectNode(directory, pkgJsonPath)
    }

    // Rust projects
    const cargoPath = path.join(directory, "Cargo.toml")
    if (fs.existsSync(cargoPath)) {
      return {
        typecheck: "cargo check",
        test: "cargo test",
        lint: "cargo clippy",
        build: "cargo build",
      }
    }

    // Python projects
    const pyprojectPath = path.join(directory, "pyproject.toml")
    const setupPyPath = path.join(directory, "setup.py")
    if (fs.existsSync(pyprojectPath) || fs.existsSync(setupPyPath)) {
      return detectPython(directory)
    }

    // Go projects
    const goModPath = path.join(directory, "go.mod")
    if (fs.existsSync(goModPath)) {
      return {
        typecheck: "go vet ./...",
        test: "go test ./...",
        build: "go build ./...",
      }
    }

    return {}
  }

  /**
   * Detects Node/Bun project commands from package.json.
   */
  function detectNode(directory: string, pkgJsonPath: string): Commands {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"))
      const scripts = pkg.scripts ?? {}
      const commands: Commands = {}

      // Detect package manager
      const pm = detectPackageManager(directory)

      // Typecheck
      if (scripts.typecheck) {
        commands.typecheck = `${pm} run typecheck`
      } else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        // Has TypeScript but no typecheck script — try direct tsc
        const tscPath = path.join(directory, "node_modules", ".bin", "tsc")
        if (fs.existsSync(tscPath)) {
          commands.typecheck = `${pm === "bun" ? "bun" : "npx"} tsc --noEmit`
        }
      }

      // Test
      if (scripts.test) {
        commands.test = `${pm} ${pm === "npm" ? "run " : ""}test`
      } else if (pm === "bun") {
        commands.test = "bun test"
      }

      // Lint
      if (scripts.lint) {
        commands.lint = `${pm} run lint`
      }

      // Build
      if (scripts.build) {
        commands.build = `${pm} run build`
      }

      return commands
    } catch {
      return {}
    }
  }

  /**
   * Detects Python project commands.
   */
  function detectPython(directory: string): Commands {
    const commands: Commands = {}

    // Check for common tools
    if (fs.existsSync(path.join(directory, "mypy.ini")) || fs.existsSync(path.join(directory, "pyproject.toml"))) {
      commands.typecheck = "mypy ."
    }

    // Pytest is the most common
    if (
      fs.existsSync(path.join(directory, "pytest.ini")) ||
      fs.existsSync(path.join(directory, "conftest.py")) ||
      fs.existsSync(path.join(directory, "tests"))
    ) {
      commands.test = "pytest"
    }

    // Ruff or flake8
    if (fs.existsSync(path.join(directory, "ruff.toml")) || fs.existsSync(path.join(directory, ".ruff.toml"))) {
      commands.lint = "ruff check ."
    } else if (fs.existsSync(path.join(directory, ".flake8"))) {
      commands.lint = "flake8 ."
    }

    return commands
  }

  /**
   * Detects the package manager for a Node project.
   */
  function detectPackageManager(directory: string): "bun" | "pnpm" | "yarn" | "npm" {
    if (fs.existsSync(path.join(directory, "bun.lockb")) || fs.existsSync(path.join(directory, "bun.lock"))) return "bun"
    if (fs.existsSync(path.join(directory, "pnpm-lock.yaml"))) return "pnpm"
    if (fs.existsSync(path.join(directory, "yarn.lock"))) return "yarn"
    return "npm"
  }

  /**
   * Detects the project type from its root directory.
   *
   * @param directory - Project root
   * @returns Project type identifier
   */
  export function detectProjectType(directory: string): ProjectType {
    if (fs.existsSync(path.join(directory, "package.json"))) return "node"
    if (fs.existsSync(path.join(directory, "go.mod"))) return "go"
    if (fs.existsSync(path.join(directory, "Cargo.toml"))) return "rust"
    if (fs.existsSync(path.join(directory, "pyproject.toml")) || fs.existsSync(path.join(directory, "setup.py")))
      return "python"
    return "unknown"
  }

  /**
   * Returns what targeting support is available for each step.
   *
   * @param directory - Project root
   * @returns Per-step targeting support flags
   */
  export function targetingSupport(directory: string): TargetingSupport {
    const type = detectProjectType(directory)
    switch (type) {
      case "node":
        // tsgo supports file targeting; tsc does not
        // Check if the typecheck script uses tsgo
        return {
          typecheck: hasTargetableTypecheck(directory),
          test: true,
          lint: false,
          build: false,
        }
      case "go":
        return { typecheck: true, test: true, lint: false, build: true }
      case "python":
        return { typecheck: true, test: true, lint: true, build: false }
      case "rust":
        return { typecheck: false, test: false, lint: false, build: false }
      default:
        return { typecheck: false, test: false, lint: false, build: false }
    }
  }

  /**
   * Builds a targeted command for a specific step with file arguments.
   *
   * Returns the modified command with files appended, or the original
   * command if targeting isn't supported for this step/project type.
   *
   * @param baseCommand - The detected command (e.g., "bun run typecheck")
   * @param step - Which verification step
   * @param files - Files to target
   * @param directory - Project root
   * @returns Modified command string
   */
  export function buildTargetedCommand(
    baseCommand: string,
    step: "typecheck" | "test" | "lint" | "build",
    files: string[],
    directory: string,
  ): string {
    if (files.length === 0) return baseCommand

    const type = detectProjectType(directory)

    switch (type) {
      case "node":
        if (step === "typecheck" && hasTargetableTypecheck(directory)) {
          // tsgo supports file args directly
          return `${baseCommand} ${files.join(" ")}`
        }
        if (step === "test") {
          return `${baseCommand} ${files.join(" ")}`
        }
        return baseCommand

      case "go":
        if (step === "typecheck" || step === "test" || step === "build") {
          // Go targets packages (directories), not individual files
          const dirs = [...new Set(files.map((f) => "./" + path.dirname(f)))]
          return `${baseCommand.replace("./...", "")}${dirs.join(" ")}`
        }
        return baseCommand

      case "python":
        if (step === "typecheck" || step === "test" || step === "lint") {
          return `${baseCommand.replace(" .", "")} ${files.join(" ")}`
        }
        return baseCommand

      default:
        return baseCommand
    }
  }

  /**
   * Checks if the project's typecheck command supports file targeting.
   * Currently, tsgo supports file args but tsc does not.
   */
  function hasTargetableTypecheck(directory: string): boolean {
    try {
      const pkgJsonPath = path.join(directory, "package.json")
      if (!fs.existsSync(pkgJsonPath)) return false
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"))
      const scripts = pkg.scripts ?? {}
      const typecheckScript = scripts.typecheck ?? ""
      return typecheckScript.includes("tsgo")
    } catch {
      return false
    }
  }
}
