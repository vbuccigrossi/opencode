import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

export namespace Flag {
  export const CORTEX_AUTO_SHARE = truthy("CORTEX_AUTO_SHARE")
  export const CORTEX_GIT_BASH_PATH = process.env["CORTEX_GIT_BASH_PATH"]
  export const CORTEX_CONFIG = process.env["CORTEX_CONFIG"]
  export declare const CORTEX_TUI_CONFIG: string | undefined
  export declare const CORTEX_CONFIG_DIR: string | undefined
  export const CORTEX_CONFIG_CONTENT = process.env["CORTEX_CONFIG_CONTENT"]
  export const CORTEX_DISABLE_AUTOUPDATE = truthy("CORTEX_DISABLE_AUTOUPDATE")
  export const CORTEX_DISABLE_PRUNE = truthy("CORTEX_DISABLE_PRUNE")
  export const CORTEX_DISABLE_TERMINAL_TITLE = truthy("CORTEX_DISABLE_TERMINAL_TITLE")
  export const CORTEX_PERMISSION = process.env["CORTEX_PERMISSION"]
  export const CORTEX_DISABLE_DEFAULT_PLUGINS = truthy("CORTEX_DISABLE_DEFAULT_PLUGINS")
  export const CORTEX_DISABLE_LSP_DOWNLOAD = truthy("CORTEX_DISABLE_LSP_DOWNLOAD")
  export const CORTEX_ENABLE_EXPERIMENTAL_MODELS = truthy("CORTEX_ENABLE_EXPERIMENTAL_MODELS")
  export const CORTEX_DISABLE_AUTOCOMPACT = truthy("CORTEX_DISABLE_AUTOCOMPACT")
  export const CORTEX_DISABLE_MODELS_FETCH = truthy("CORTEX_DISABLE_MODELS_FETCH")
  export const CORTEX_DISABLE_CLAUDE_CODE = truthy("CORTEX_DISABLE_CLAUDE_CODE")
  export const CORTEX_DISABLE_CLAUDE_CODE_PROMPT =
    CORTEX_DISABLE_CLAUDE_CODE || truthy("CORTEX_DISABLE_CLAUDE_CODE_PROMPT")
  export const CORTEX_DISABLE_CLAUDE_CODE_SKILLS =
    CORTEX_DISABLE_CLAUDE_CODE || truthy("CORTEX_DISABLE_CLAUDE_CODE_SKILLS")
  export const CORTEX_DISABLE_EXTERNAL_SKILLS =
    CORTEX_DISABLE_CLAUDE_CODE_SKILLS || truthy("CORTEX_DISABLE_EXTERNAL_SKILLS")
  export declare const CORTEX_DISABLE_PROJECT_CONFIG: boolean
  export const CORTEX_FAKE_VCS = process.env["CORTEX_FAKE_VCS"]
  export declare const CORTEX_CLIENT: string
  export const CORTEX_SERVER_PASSWORD = process.env["CORTEX_SERVER_PASSWORD"]
  export const CORTEX_SERVER_USERNAME = process.env["CORTEX_SERVER_USERNAME"]
  export const CORTEX_ENABLE_QUESTION_TOOL = truthy("CORTEX_ENABLE_QUESTION_TOOL")

  // Experimental
  export const CORTEX_EXPERIMENTAL = truthy("CORTEX_EXPERIMENTAL")
  export const CORTEX_EXPERIMENTAL_FILEWATCHER = Config.boolean("CORTEX_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  )
  export const CORTEX_EXPERIMENTAL_DISABLE_FILEWATCHER = Config.boolean(
    "CORTEX_EXPERIMENTAL_DISABLE_FILEWATCHER",
  ).pipe(Config.withDefault(false))
  export const CORTEX_EXPERIMENTAL_ICON_DISCOVERY =
    CORTEX_EXPERIMENTAL || truthy("CORTEX_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["CORTEX_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const CORTEX_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("CORTEX_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const CORTEX_ENABLE_EXA =
    truthy("CORTEX_ENABLE_EXA") || CORTEX_EXPERIMENTAL || truthy("CORTEX_EXPERIMENTAL_EXA")
  export const CORTEX_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("CORTEX_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const CORTEX_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("CORTEX_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const CORTEX_EXPERIMENTAL_OXFMT = CORTEX_EXPERIMENTAL || truthy("CORTEX_EXPERIMENTAL_OXFMT")
  export const CORTEX_EXPERIMENTAL_LSP_TY = truthy("CORTEX_EXPERIMENTAL_LSP_TY")
  export const CORTEX_EXPERIMENTAL_LSP_RUFF = truthy("CORTEX_EXPERIMENTAL_LSP_RUFF")
  export const CORTEX_EXPERIMENTAL_LSP_TOOL = CORTEX_EXPERIMENTAL || truthy("CORTEX_EXPERIMENTAL_LSP_TOOL")
  export const CORTEX_DISABLE_FILETIME_CHECK = Config.boolean("CORTEX_DISABLE_FILETIME_CHECK").pipe(
    Config.withDefault(false),
  )
  export const CORTEX_EXPERIMENTAL_PLAN_MODE = CORTEX_EXPERIMENTAL || truthy("CORTEX_EXPERIMENTAL_PLAN_MODE")
  export const CORTEX_EXPERIMENTAL_WORKSPACES = CORTEX_EXPERIMENTAL || truthy("CORTEX_EXPERIMENTAL_WORKSPACES")
  export const CORTEX_EXPERIMENTAL_MARKDOWN = !falsy("CORTEX_EXPERIMENTAL_MARKDOWN")
  export const CORTEX_MODELS_URL = process.env["CORTEX_MODELS_URL"]
  export const CORTEX_MODELS_PATH = process.env["CORTEX_MODELS_PATH"]
  export const CORTEX_DB = process.env["CORTEX_DB"]
  export const CORTEX_DISABLE_CHANNEL_DB = truthy("CORTEX_DISABLE_CHANNEL_DB")
  export const CORTEX_SKIP_MIGRATIONS = truthy("CORTEX_SKIP_MIGRATIONS")
  export const CORTEX_STRICT_CONFIG_DEPS = truthy("CORTEX_STRICT_CONFIG_DEPS")

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for CORTEX_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "CORTEX_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("CORTEX_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for CORTEX_TUI_CONFIG
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "CORTEX_TUI_CONFIG", {
  get() {
    return process.env["CORTEX_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for CORTEX_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "CORTEX_CONFIG_DIR", {
  get() {
    return process.env["CORTEX_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for CORTEX_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "CORTEX_CLIENT", {
  get() {
    return process.env["CORTEX_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
