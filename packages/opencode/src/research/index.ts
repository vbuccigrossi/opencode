import { Log } from "@/util/log"

/**
 * Web research engine — structured web research for error lookups,
 * documentation, changelogs, and library comparisons.
 *
 * Builds URLs and parses results from package registries, documentation
 * sites, and search engines. Works standalone via fetch().
 */
export namespace Research {
  const log = Log.create({ service: "research" })

  /** A search result with extracted content. */
  export interface SearchResult {
    title: string
    url: string
    snippet: string
    source: string
  }

  /** Documentation result. */
  export interface DocResult {
    package: string
    version?: string
    description: string
    homepage?: string
    repository?: string
    readme?: string
    keywords?: string[]
  }

  /** Changelog entry. */
  export interface ChangelogEntry {
    version: string
    date?: string
    changes: string[]
  }

  /** Registry URLs for package lookups. */
  const REGISTRIES = {
    npm: (pkg: string) => `https://registry.npmjs.org/${encodeURIComponent(pkg)}`,
    pypi: (pkg: string) => `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`,
    crates: (pkg: string) => `https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}`,
    go: (pkg: string) => `https://pkg.go.dev/${encodeURIComponent(pkg)}`,
  }

  /**
   * Look up documentation for a package from its registry.
   *
   * @param packageName - Package name
   * @param registry - Package registry (npm, pypi, crates, go)
   * @returns Documentation result
   */
  export async function docs(
    packageName: string,
    registry: "npm" | "pypi" | "crates" | "go" = "npm",
  ): Promise<DocResult> {
    switch (registry) {
      case "npm":
        return fetchNpmDocs(packageName)
      case "pypi":
        return fetchPypiDocs(packageName)
      case "crates":
        return fetchCratesDocs(packageName)
      case "go":
        return { package: packageName, description: `Go package: ${packageName}`, homepage: `https://pkg.go.dev/${packageName}` }
      default:
        throw new Error(`Unknown registry: ${registry}`)
    }
  }

  /**
   * Build a URL to search for an error message.
   *
   * @param error - Error message or code
   * @param context - Additional context (language, framework)
   * @returns Search query and URLs to try
   */
  export function errorLookup(error: string, context?: string): {
    query: string
    urls: string[]
  } {
    // Clean up the error message for search
    const cleaned = error
      .replace(/\bat\s+\S+:\d+:\d+/g, "") // Remove stack trace locations
      .replace(/\/[\w/.]+/g, "") // Remove file paths
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)

    const query = context ? `${cleaned} ${context}` : cleaned

    const urls = [
      `https://stackoverflow.com/search?q=${encodeURIComponent(query)}`,
      `https://github.com/search?q=${encodeURIComponent(query)}&type=issues`,
    ]

    // Add specific error code lookups
    const tsError = error.match(/TS(\d+)/)
    if (tsError) {
      urls.unshift(`https://typescript.tv/errors/#TS${tsError[1]}`)
    }

    const rustError = error.match(/E(\d{4})/)
    if (rustError) {
      urls.unshift(`https://doc.rust-lang.org/error_codes/E${rustError[1]}.html`)
    }

    return { query, urls }
  }

  /**
   * Build a changelog URL for a package.
   *
   * @param packageName - Package name
   * @param registry - Package registry
   * @returns URL(s) to check for changelog
   */
  export function changelogUrl(packageName: string, registry: "npm" | "pypi" | "crates" = "npm"): string[] {
    switch (registry) {
      case "npm":
        return [
          `https://www.npmjs.com/package/${packageName}?activeTab=changelog`,
          `https://github.com/search?q=repo%3A${packageName}+CHANGELOG&type=code`,
        ]
      case "pypi":
        return [
          `https://pypi.org/project/${packageName}/#history`,
        ]
      case "crates":
        return [
          `https://crates.io/crates/${packageName}/versions`,
        ]
      default:
        return []
    }
  }

  /**
   * Build a comparison query for two libraries.
   *
   * @param lib1 - First library name
   * @param lib2 - Second library name
   * @param context - Additional context
   * @returns Search query and comparison URLs
   */
  export function compare(lib1: string, lib2: string, context?: string): {
    query: string
    urls: string[]
  } {
    const query = `${lib1} vs ${lib2}${context ? ` ${context}` : ""}`
    return {
      query,
      urls: [
        `https://npmtrends.com/${lib1}-vs-${lib2}`,
        `https://stackoverflow.com/search?q=${encodeURIComponent(query)}`,
      ],
    }
  }

  /**
   * Build a code snippet search query.
   *
   * @param api - API or function name to search for
   * @param language - Programming language
   * @returns Search URLs
   */
  export function snippetSearch(api: string, language?: string): {
    query: string
    urls: string[]
  } {
    const query = language ? `${api} ${language} example` : `${api} example`
    return {
      query,
      urls: [
        `https://github.com/search?q=${encodeURIComponent(api)}+language%3A${language ?? "typescript"}&type=code`,
      ],
    }
  }

  /**
   * Format a doc result for display.
   *
   * @param doc - Documentation result
   * @returns Formatted string
   */
  export function formatDoc(doc: DocResult): string {
    const lines: string[] = []
    lines.push(`${doc.package}${doc.version ? ` v${doc.version}` : ""}`)
    lines.push(doc.description)

    if (doc.homepage) lines.push(`Homepage: ${doc.homepage}`)
    if (doc.repository) lines.push(`Repository: ${doc.repository}`)
    if (doc.keywords && doc.keywords.length > 0) {
      lines.push(`Keywords: ${doc.keywords.join(", ")}`)
    }
    if (doc.readme) {
      lines.push("")
      lines.push("README (excerpt):")
      lines.push(doc.readme.slice(0, 2000))
    }

    return lines.join("\n")
  }

  /**
   * Format search results for display.
   *
   * @param results - Search results
   * @returns Formatted string
   */
  export function formatResults(results: SearchResult[]): string {
    if (results.length === 0) return "No results found."

    return results
      .map((r, i) => `${i + 1}. [${r.source}] ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n")
  }

  // ─── Registry Fetchers ─────────────────────────────────────────

  /** Fetch documentation from npm registry. */
  async function fetchNpmDocs(packageName: string): Promise<DocResult> {
    const url = REGISTRIES.npm(packageName)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`npm registry returned ${response.status}`)

      const data = await response.json() as any
      const latest = data["dist-tags"]?.latest
      const versionData = latest ? data.versions?.[latest] : undefined

      return {
        package: packageName,
        version: latest,
        description: data.description ?? "",
        homepage: data.homepage,
        repository: typeof data.repository === "object" ? data.repository.url : data.repository,
        readme: data.readme?.slice(0, 3000),
        keywords: data.keywords,
      }
    } catch (err: any) {
      log.warn("npm docs fetch failed", { packageName, error: err.message })
      return {
        package: packageName,
        description: `Failed to fetch: ${err.message}`,
      }
    }
  }

  /** Fetch documentation from PyPI. */
  async function fetchPypiDocs(packageName: string): Promise<DocResult> {
    const url = REGISTRIES.pypi(packageName)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`PyPI returned ${response.status}`)

      const data = await response.json() as any
      const info = data.info ?? {}

      return {
        package: packageName,
        version: info.version,
        description: info.summary ?? info.description?.slice(0, 500) ?? "",
        homepage: info.home_page ?? info.project_url,
        repository: info.project_urls?.Repository ?? info.project_urls?.Source,
        keywords: info.keywords?.split(",").map((k: string) => k.trim()),
      }
    } catch (err: any) {
      log.warn("pypi docs fetch failed", { packageName, error: err.message })
      return {
        package: packageName,
        description: `Failed to fetch: ${err.message}`,
      }
    }
  }

  /** Fetch documentation from crates.io. */
  async function fetchCratesDocs(packageName: string): Promise<DocResult> {
    const url = REGISTRIES.crates(packageName)
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "opencode-agent/1.0" },
      })
      if (!response.ok) throw new Error(`crates.io returned ${response.status}`)

      const data = await response.json() as any
      const crate = data.crate ?? {}

      return {
        package: packageName,
        version: crate.max_version ?? crate.newest_version,
        description: crate.description ?? "",
        homepage: crate.homepage,
        repository: crate.repository,
        keywords: crate.keywords,
      }
    } catch (err: any) {
      log.warn("crates docs fetch failed", { packageName, error: err.message })
      return {
        package: packageName,
        description: `Failed to fetch: ${err.message}`,
      }
    }
  }
}
