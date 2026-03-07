import { Log } from "../util/log"
import { spawn } from "child_process"
import path from "path"

/**
 * Structured git history search.
 *
 * Provides blame, log, pickaxe (text introduction/removal), and commit
 * search with structured JSON output instead of raw git text.
 */
export namespace GitHistory {
  const log = Log.create({ service: "search.git-history" })

  /** A structured commit entry. */
  export interface Commit {
    hash: string
    shortHash: string
    author: string
    authorEmail: string
    date: string
    message: string
    files?: string[]
  }

  /** A structured blame entry. */
  export interface BlameLine {
    line: number
    content: string
    commit: string
    author: string
    date: string
    message: string
  }

  /** Search options for log/search. */
  export interface LogOptions {
    /** Limit number of results. */
    maxCount?: number
    /** Filter by author name/email. */
    author?: string
    /** Filter commits since date (ISO or relative like "2 weeks ago"). */
    since?: string
    /** Filter commits until date. */
    until?: string
    /** Filter by message pattern (grep). */
    grep?: string
    /** Follow file renames. */
    follow?: boolean
    /** Specific file to filter. */
    file?: string
  }

  /** Run a git command and return stdout. */
  function git(args: string[], cwd: string, timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => {
        proc.kill("SIGTERM")
        reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString()
      })
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString()
      })
      proc.on("close", (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.substring(0, 200)}`))
      })
      proc.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /**
   * Structured git log.
   *
   * @param cwd - Repository directory
   * @param options - Log filtering options
   * @returns Parsed commit entries
   */
  export async function logHistory(cwd: string, options?: LogOptions): Promise<Commit[]> {
    const SEP = "---GIT_LOG_SEP---"
    const format = `${SEP}%n%H%n%h%n%an%n%ae%n%aI%n%s`

    const args = ["log", `--format=${format}`, "--no-merges"]
    if (options?.maxCount) args.push(`-n`, `${options.maxCount}`)
    if (options?.author) args.push(`--author=${options.author}`)
    if (options?.since) args.push(`--since=${options.since}`)
    if (options?.until) args.push(`--until=${options.until}`)
    if (options?.grep) args.push(`--grep=${options.grep}`)
    if (options?.follow && options?.file) args.push("--follow")
    args.push("--")
    if (options?.file) args.push(options.file)

    const output = await git(args, cwd)
    return parseLog(output, SEP)
  }

  function parseLog(output: string, sep: string): Commit[] {
    const commits: Commit[] = []
    const blocks = output.split(sep).filter((b) => b.trim())

    for (const block of blocks) {
      const lines = block.trim().split("\n")
      if (lines.length < 5) continue
      commits.push({
        hash: lines[0],
        shortHash: lines[1],
        author: lines[2],
        authorEmail: lines[3],
        date: lines[4],
        message: lines.slice(5).join("\n"),
      })
    }

    return commits
  }

  /**
   * Search commit messages.
   *
   * @param cwd - Repository directory
   * @param query - Search text for commit messages
   * @param options - Additional filtering
   * @returns Matching commits
   */
  export async function search(cwd: string, query: string, options?: LogOptions): Promise<Commit[]> {
    return logHistory(cwd, {
      ...options,
      grep: query,
      maxCount: options?.maxCount ?? 20,
    })
  }

  /**
   * Structured git blame.
   *
   * @param cwd - Repository directory
   * @param file - File to blame
   * @param lineRange - Optional line range [start, end] (1-based)
   * @returns Blame entries per line
   */
  export async function blame(cwd: string, file: string, lineRange?: [number, number]): Promise<BlameLine[]> {
    const args = ["blame", "--porcelain"]
    if (lineRange) args.push(`-L`, `${lineRange[0]},${lineRange[1]}`)
    args.push("--", file)

    const output = await git(args, cwd)
    return parseBlame(output)
  }

  function parseBlame(output: string): BlameLine[] {
    const results: BlameLine[] = []
    const lines = output.split("\n")
    let i = 0

    while (i < lines.length) {
      const headerMatch = lines[i].match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/)
      if (!headerMatch) {
        i++
        continue
      }

      const commitHash = headerMatch[1]
      const lineNum = parseInt(headerMatch[3])
      let author = ""
      let date = ""
      let message = ""
      let content = ""

      i++
      while (i < lines.length) {
        if (lines[i].startsWith("\t")) {
          content = lines[i].substring(1)
          i++
          break
        }
        if (lines[i].startsWith("author ")) author = lines[i].substring(7)
        else if (lines[i].startsWith("author-time ")) {
          const ts = parseInt(lines[i].substring(12))
          date = new Date(ts * 1000).toISOString()
        } else if (lines[i].startsWith("summary ")) message = lines[i].substring(8)
        i++
      }

      results.push({
        line: lineNum,
        content,
        commit: commitHash.substring(0, 8),
        author,
        date,
        message,
      })
    }

    return results
  }

  /**
   * Pickaxe search — find commits that introduced or removed specific text.
   *
   * This is the "killer feature": answers "when was this added?" or "who removed X?"
   *
   * @param cwd - Repository directory
   * @param text - Text to search for in diffs
   * @param options - Additional filtering
   * @returns Commits that introduced or removed the text
   */
  export async function pickaxe(cwd: string, text: string, options?: LogOptions): Promise<Commit[]> {
    const SEP = "---GIT_LOG_SEP---"
    const format = `${SEP}%n%H%n%h%n%an%n%ae%n%aI%n%s`

    const args = ["log", `--format=${format}`, `-S`, text, "--no-merges"]
    if (options?.maxCount) args.push(`-n`, `${options.maxCount}`)
    else args.push("-n", "20")
    if (options?.author) args.push(`--author=${options.author}`)
    if (options?.since) args.push(`--since=${options.since}`)
    if (options?.file) {
      args.push("--")
      args.push(options.file)
    }

    const output = await git(args, cwd)
    return parseLog(output, SEP)
  }

  /**
   * Get commits between two refs (useful for bisection/regression analysis).
   *
   * @param cwd - Repository directory
   * @param good - Known good commit/ref
   * @param bad - Known bad commit/ref
   * @returns Commits in the range
   */
  export async function commitRange(cwd: string, good: string, bad: string): Promise<Commit[]> {
    const SEP = "---GIT_LOG_SEP---"
    const format = `${SEP}%n%H%n%h%n%an%n%ae%n%aI%n%s`

    const args = ["log", `--format=${format}`, "--no-merges", `${good}..${bad}`]
    const output = await git(args, cwd)
    return parseLog(output, SEP)
  }

  /**
   * Get files changed in a commit.
   *
   * @param cwd - Repository directory
   * @param ref - Commit hash or ref
   * @returns List of changed file paths
   */
  export async function filesChanged(cwd: string, ref: string): Promise<string[]> {
    const output = await git(["diff-tree", "--no-commit-id", "-r", "--name-only", ref], cwd)
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  }

  /** Format commits as readable output. */
  export function format(commits: Commit[], relativeTo?: string): string {
    if (commits.length === 0) return "No matching commits found."

    return commits
      .map((c) => {
        const files = c.files ? `\n  Files: ${c.files.join(", ")}` : ""
        return `${c.shortHash} ${c.date.substring(0, 10)} ${c.author}\n  ${c.message}${files}`
      })
      .join("\n\n")
  }
}
