import { Log } from "@/util/log"
import { Detector } from "./detector"
import { readFile, readdir, access, stat } from "fs/promises"
import { join, relative } from "path"

/**
 * Project onboarding — automatic first-encounter project model.
 *
 * On first session with a project, builds a structured model of the
 * codebase: language, framework, entry points, key directories,
 * conventions, and architecture summary.
 *
 * The model is stored in memory and injected into the system prompt
 * on every subsequent session.
 */
export namespace Onboarding {
  const log = Log.create({ service: "onboarding" })

  /** Structured project model. */
  export interface ProjectModel {
    /** Project name (from manifest or directory). */
    name: string
    /** Primary language. */
    language: string
    /** Framework, if detected. */
    framework?: string
    /** Primary build tool. */
    buildTool: string
    /** Test framework, if detected. */
    testFramework?: string
    /** Package manager. */
    packageManager?: string
    /** Entry point files. */
    entryPoints: string[]
    /** Key directories with their roles. */
    keyDirectories: Array<{ path: string; role: string }>
    /** Detected conventions. */
    conventions: string[]
    /** 2-3 sentence architecture summary. */
    architecture: string
  }

  /** Stored models, keyed by project root. */
  const models = new Map<string, ProjectModel>()

  /**
   * Check if onboarding has been done for a project.
   *
   * @param cwd - Project root directory
   * @returns true if a model exists
   */
  export function isOnboarded(cwd: string): boolean {
    return models.has(cwd)
  }

  /**
   * Run the onboarding protocol for a project.
   *
   * 1. Detect language, framework, build tool, test framework
   * 2. Scan directory structure for key directories
   * 3. Identify entry points
   * 4. Read README for architecture description
   * 5. Detect conventions from source files
   * 6. Build and store the model
   *
   * @param cwd - Project root directory
   * @returns The built project model
   */
  export async function run(cwd: string): Promise<ProjectModel> {
    const startTime = Date.now()

    // Step 1: Detect language and tooling
    const detection = await Detector.detect(cwd)

    // Step 2: Get project name
    const name = await detectProjectName(cwd)

    // Step 3: Scan directory structure
    const keyDirectories = await scanDirectories(cwd)

    // Step 4: Find entry points
    const entryPoints = await findEntryPoints(cwd, detection.language)

    // Step 5: Read README for architecture
    const architecture = await extractArchitecture(cwd, name, detection)

    // Step 6: Detect conventions
    const conventions = await detectConventions(cwd, detection.language)

    const model: ProjectModel = {
      name,
      language: detection.language,
      framework: detection.framework,
      buildTool: detection.buildTool,
      testFramework: detection.testFramework,
      packageManager: detection.packageManager,
      entryPoints,
      keyDirectories,
      conventions,
      architecture,
    }

    models.set(cwd, model)

    const duration = Date.now() - startTime
    log.info("onboarding complete", { name, language: detection.language, duration })

    return model
  }

  /**
   * Get the stored project model.
   *
   * @param cwd - Project root directory
   * @returns Model, or undefined if not onboarded
   */
  export function getModel(cwd: string): ProjectModel | undefined {
    return models.get(cwd)
  }

  /**
   * Format the project model for system prompt injection.
   *
   * @param model - Project model to format
   * @returns Formatted `<project-model>` block
   */
  export function format(model: ProjectModel): string {
    const lines: string[] = []

    lines.push(`<project-model>`)
    lines.push(`  Project: ${model.name}`)
    lines.push(`  Language: ${model.language}${model.framework ? ` (${model.framework})` : ""}`)
    lines.push(`  Build: ${model.buildTool}${model.packageManager ? ` via ${model.packageManager}` : ""}`)
    if (model.testFramework) lines.push(`  Tests: ${model.testFramework}`)

    if (model.entryPoints.length > 0) {
      lines.push(`  Entry points: ${model.entryPoints.join(", ")}`)
    }

    if (model.keyDirectories.length > 0) {
      lines.push(`  Key dirs:`)
      for (const dir of model.keyDirectories) {
        lines.push(`    ${dir.path}/ — ${dir.role}`)
      }
    }

    if (model.conventions.length > 0) {
      lines.push(`  Conventions:`)
      for (const conv of model.conventions) {
        lines.push(`    - ${conv}`)
      }
    }

    if (model.architecture) {
      lines.push(`  Architecture: ${model.architecture}`)
    }

    lines.push(`</project-model>`)

    return lines.join("\n")
  }

  /**
   * Clear stored model for a project.
   *
   * @param cwd - Project root directory
   */
  export function clear(cwd: string): void {
    models.delete(cwd)
  }

  /**
   * Clear all stored models.
   */
  export function clearAll(): void {
    models.clear()
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Detect project name from manifest files. */
  async function detectProjectName(cwd: string): Promise<string> {
    // Try package.json
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"))
      if (pkg.name) return pkg.name
    } catch {}

    // Try Cargo.toml
    try {
      const cargo = await readFile(join(cwd, "Cargo.toml"), "utf-8")
      const nameMatch = cargo.match(/name\s*=\s*"(.+)"/)
      if (nameMatch) return nameMatch[1]
    } catch {}

    // Try go.mod
    try {
      const gomod = await readFile(join(cwd, "go.mod"), "utf-8")
      const moduleMatch = gomod.match(/module\s+(\S+)/)
      if (moduleMatch) return moduleMatch[1].split("/").pop() ?? moduleMatch[1]
    } catch {}

    // Fallback to directory name
    return cwd.split("/").pop() ?? "unknown"
  }

  /** Scan for key directories. */
  async function scanDirectories(
    cwd: string,
  ): Promise<Array<{ path: string; role: string }>> {
    const dirRoles: Record<string, string> = {
      src: "source code",
      lib: "library code",
      app: "application code",
      pages: "page components",
      components: "UI components",
      hooks: "React hooks",
      utils: "utilities",
      helpers: "helper functions",
      config: "configuration",
      configs: "configuration",
      test: "tests",
      tests: "tests",
      __tests__: "tests",
      spec: "tests",
      scripts: "build/utility scripts",
      docs: "documentation",
      public: "static assets",
      static: "static assets",
      assets: "assets",
      styles: "stylesheets",
      api: "API routes/handlers",
      routes: "route definitions",
      middleware: "middleware",
      models: "data models",
      services: "service layer",
      controllers: "controllers",
      views: "view templates",
      types: "type definitions",
      interfaces: "interfaces",
      migrations: "database migrations",
      cmd: "CLI commands (Go)",
      internal: "internal packages (Go)",
      pkg: "public packages (Go)",
    }

    const results: Array<{ path: string; role: string }> = []

    try {
      const entries = await readdir(cwd, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue

        const role = dirRoles[entry.name]
        if (role) {
          results.push({ path: entry.name, role })
        }
      }
    } catch {
      // Directory read failed
    }

    // Also check src/ subdirectories
    try {
      const srcEntries = await readdir(join(cwd, "src"), { withFileTypes: true })
      for (const entry of srcEntries) {
        if (!entry.isDirectory()) continue
        const role = dirRoles[entry.name]
        if (role) {
          results.push({ path: `src/${entry.name}`, role })
        }
      }
    } catch {
      // No src/ directory
    }

    return results.slice(0, 15) // Cap at 15 directories
  }

  /** Find entry point files. */
  async function findEntryPoints(cwd: string, language: string): Promise<string[]> {
    const candidates: string[] = []

    const entryFiles: Record<string, string[]> = {
      TypeScript: ["src/index.ts", "src/main.ts", "src/app.ts", "index.ts", "main.ts", "server.ts"],
      JavaScript: ["src/index.js", "src/main.js", "src/app.js", "index.js", "main.js", "server.js"],
      Go: ["main.go", "cmd/main.go"],
      Rust: ["src/main.rs", "src/lib.rs"],
      Python: ["main.py", "app.py", "src/main.py", "__main__.py"],
    }

    const filesToCheck = entryFiles[language] ?? entryFiles["TypeScript"]!

    for (const file of filesToCheck) {
      try {
        await access(join(cwd, file))
        candidates.push(file)
      } catch {
        // Not found
      }
    }

    // Also check package.json main/bin fields
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"))
      if (pkg.main && !candidates.includes(pkg.main)) candidates.push(pkg.main)
      if (pkg.bin) {
        const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin)
        for (const bin of bins as string[]) {
          if (!candidates.includes(bin)) candidates.push(bin)
        }
      }
    } catch {}

    return candidates.slice(0, 5)
  }

  /** Extract architecture description from README. */
  async function extractArchitecture(
    cwd: string,
    name: string,
    detection: Detector.Detection,
  ): Promise<string> {
    // Try to read README
    const readmeNames = ["README.md", "readme.md", "README.rst", "README.txt", "README"]
    let readme = ""

    for (const readmeName of readmeNames) {
      try {
        readme = await readFile(join(cwd, readmeName), "utf-8")
        break
      } catch {}
    }

    if (readme.length > 0) {
      // Extract first paragraph or description
      const lines = readme.split("\n")
      const descLines: string[] = []
      let foundContent = false

      for (const line of lines) {
        const trimmed = line.trim()
        // Skip title (# heading)
        if (trimmed.startsWith("#") && !foundContent) continue
        // Skip badges and empty lines at start
        if (!foundContent && (trimmed === "" || trimmed.startsWith("["))) continue

        if (trimmed.length > 0) {
          foundContent = true
          descLines.push(trimmed)
        } else if (foundContent && descLines.length > 0) {
          break // End of first paragraph
        }

        if (descLines.length >= 3) break
      }

      if (descLines.length > 0) {
        return descLines.join(" ").slice(0, 300)
      }
    }

    // Fallback: generate a basic description
    const parts = [`${name} is a ${detection.language} project`]
    if (detection.framework) parts[0] += ` using ${detection.framework}`
    parts[0] += "."

    return parts.join(" ")
  }

  /** Detect coding conventions from source files. */
  async function detectConventions(cwd: string, language: string): Promise<string[]> {
    const conventions: string[] = []

    // Find some source files to analyze
    const srcDirs = ["src", "lib", "app", "."]
    const extensions: Record<string, string[]> = {
      TypeScript: [".ts", ".tsx"],
      JavaScript: [".js", ".jsx"],
      Go: [".go"],
      Rust: [".rs"],
      Python: [".py"],
    }

    const exts = extensions[language] ?? extensions["TypeScript"]!
    const sourceFiles: string[] = []

    for (const dir of srcDirs) {
      try {
        const entries = await readdir(join(cwd, dir), { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
            sourceFiles.push(join(dir, entry.name))
          }
        }
      } catch {}

      if (sourceFiles.length >= 5) break
    }

    if (sourceFiles.length === 0) return conventions

    // Analyze first few files for patterns
    let usesNamespaces = false
    let usesSemicolons = false
    let usesTabs = false
    let usesDoubleQuotes = false
    let usesSingleQuotes = false

    for (const file of sourceFiles.slice(0, 5)) {
      try {
        const content = await readFile(join(cwd, file), "utf-8")
        const lines = content.split("\n").slice(0, 50)

        for (const line of lines) {
          if (line.includes("export namespace ")) usesNamespaces = true
          if (/;\s*$/.test(line) && !line.includes("//")) usesSemicolons = true
          if (line.startsWith("\t")) usesTabs = true
          if (line.includes('"')) usesDoubleQuotes = true
          if (line.includes("'")) usesSingleQuotes = true
        }
      } catch {}
    }

    if (usesNamespaces) conventions.push("Uses TypeScript namespaces for module organization")
    if (usesSemicolons) conventions.push("Uses semicolons")
    else conventions.push("No semicolons (relies on ASI)")
    if (usesTabs) conventions.push("Uses tab indentation")
    else conventions.push("Uses space indentation")
    if (usesDoubleQuotes && !usesSingleQuotes) conventions.push("Prefers double quotes")
    else if (usesSingleQuotes && !usesDoubleQuotes) conventions.push("Prefers single quotes")

    // Check for naming conventions in file names
    const fileNames = sourceFiles.map((f) => f.split("/").pop() ?? "")
    const hasKebabCase = fileNames.some((f) => /-/.test(f.replace(/\.\w+$/, "")))
    const hasCamelCase = fileNames.some((f) => /[a-z][A-Z]/.test(f.replace(/\.\w+$/, "")))
    const hasSnakeCase = fileNames.some((f) => /_/.test(f.replace(/\.\w+$/, "")) && !f.includes(".test."))

    if (hasKebabCase) conventions.push("Kebab-case file naming")
    if (hasCamelCase) conventions.push("camelCase file naming")
    if (hasSnakeCase) conventions.push("snake_case file naming")

    return conventions.slice(0, 8)
  }
}
