# Phase 6: Agent Autonomy — Development Plan

## Vision

Phase 5 gave the agent intelligence — structured state, dynamic context, strategy selection, self-monitoring. Phase 6 gives it **autonomy** — the ability to test its own work, explore in parallel, preserve knowledge across compaction boundaries, and onboard to new projects instantly.

These six pillars address the remaining failure modes: logic errors that pass type checking, sequential bottlenecks in exploration, information loss during compaction, cold-start on new codebases, wasted context on failed edits, and suboptimal tool selection.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Loop                              │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Strategy  │→│ Sandbox   │→│ Tool Exec │→│ Knowledge │   │
│  │ Engine    │  │ Pre-check │  │           │  │ Extract   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│       ↑              ↑              │              │         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Tool     │  │ Parallel  │  │ Dynamic  │  │ Project  │   │
│  │ Tracker  │←│ Explorer  │←│ Context  │←│ Model    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Pillar 23: Runtime Sandbox

### Problem

The agent can verify types but cannot verify behavior. A function that type-checks perfectly may return wrong values, throw unexpected errors, or have off-by-one bugs. The only way to catch these is writing a full test suite — which burns context and is overkill for quick validation.

### Solution

A lightweight sandbox that can evaluate expressions, test function calls, and run quick assertions without writing permanent test files.

### Technical Design

**New module**: `src/sandbox/index.ts`

```typescript
export namespace Sandbox {
  interface EvalResult {
    success: boolean
    output: string       // stdout + result
    error?: string       // stderr or exception
    duration: number     // ms
  }

  // Evaluate a TypeScript/JavaScript expression
  export async function eval(code: string, cwd?: string): Promise<EvalResult>

  // Run a quick assertion (returns pass/fail)
  export async function assert(code: string, cwd?: string): Promise<EvalResult>

  // Import a module and call a function with args
  export async function call(
    modulePath: string,
    functionName: string,
    args: unknown[],
    cwd?: string
  ): Promise<EvalResult>
}
```

**How it works**:

1. **`eval()`**: Wraps code in a temp file, runs via `bun run <tempfile>`. Captures stdout/stderr. Timeout at 5s. Temp file is deleted after execution.

2. **`assert()`**: Wraps code in `if (!(expr)) { process.exit(1) }` pattern. Returns pass/fail.

3. **`call()`**: Generates `import { fn } from "modulePath"; console.log(JSON.stringify(fn(...args)))`. Tests actual module behavior.

**Safety**:
- 5-second hard timeout (kills process)
- Read-only by convention (sandbox code shouldn't write files, but not enforced — the agent is trusted)
- Runs in project directory so imports resolve correctly
- No network access restrictions (some functions need it)

**New tool**: `src/tool/sandbox.ts`

Operations:
- `eval` — Evaluate an expression and see the result
- `assert` — Test a boolean assertion
- `call` — Import and call a specific function
- `test_snippet` — Run a mini test (expression + expected result)

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/sandbox/index.ts` | Create | Core sandbox execution engine |
| `src/tool/sandbox.ts` | Create | Agent-facing sandbox tool |
| `src/tool/registry.ts` | Modify | Register sandbox tool |
| `test/sandbox/sandbox.test.ts` | Create | Tests |

### Success Criteria

- Agent can eval `2 + 2` and get `4` back in <500ms
- Agent can import a project module and call a function
- Agent can test assertions before committing to edits
- 5-second timeout prevents runaway code
- Temp files are always cleaned up

---

## Pillar 24: Parallel Exploration

### Problem

Investigation tasks are inherently parallel — checking git history, reading related files, querying the graph, searching documentation. But the agent executes these sequentially, burning 4-6 steps on what should be a single fan-out operation.

### Solution

A structured exploration system that can fan out multiple research queries, execute them concurrently, and merge results into a compact summary.

### Technical Design

**New module**: `src/explore/index.ts`

```typescript
export namespace Explore {
  interface Query {
    id: string
    type: "read_file" | "grep" | "graph_callers" | "git_history" | "git_blame"
    params: Record<string, unknown>
  }

  interface Result {
    queryId: string
    success: boolean
    summary: string        // Compact summary of findings
    rawLength: number      // Original output length
    truncated: boolean
  }

  // Execute multiple exploration queries in parallel
  export async function fan(queries: Query[]): Promise<Result[]>

  // Merge results into a compact exploration summary
  export function summarize(results: Result[]): string
}
```

**How it works**:

1. Agent calls the explore tool with a batch of queries
2. Each query type maps to an internal operation:
   - `read_file` → read first 50 lines + function signatures
   - `grep` → search with context, return top 10 matches
   - `graph_callers` → query graph for callers/callees
   - `git_history` → recent commits touching a file
   - `git_blame` → blame a specific line range
3. All queries execute concurrently via `Promise.all`
4. Results are summarized (truncated to fit context budget)
5. Single tool output contains all findings

**New tool**: `src/tool/explore.ts`

Operations:
- `fan` — Execute multiple exploration queries in parallel
- `investigate` — Higher-level: given a question, auto-generate and execute relevant queries

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/explore/index.ts` | Create | Core parallel exploration engine |
| `src/explore/queries.ts` | Create | Query type implementations |
| `src/tool/explore.ts` | Create | Agent-facing explore tool |
| `src/tool/registry.ts` | Modify | Register explore tool |
| `test/explore/explore.test.ts` | Create | Tests |

### Success Criteria

- 5 parallel queries complete faster than 5 sequential ones
- Results are compact enough to fit in a single tool output
- Agent can investigate a bug with one tool call instead of 5
- Each query type produces useful, truncated summaries

---

## Pillar 25: Knowledge Extraction

### Problem

Compaction converts the conversation to a prose summary. Even with session state surviving, the agent loses:
- What specific code patterns it observed
- What file roles it discovered (entry point, config, test helper)
- What error messages looked like
- What conventions the codebase follows

### Solution

Before compaction, extract structured knowledge from the conversation into a persistent knowledge base that survives compaction intact.

### Technical Design

**New module**: `src/knowledge/index.ts`

```typescript
export namespace Knowledge {
  interface Fact {
    id: string
    category: "file_role" | "code_pattern" | "error_pattern" | "convention" | "dependency"
    subject: string        // What the fact is about (file path, symbol, pattern)
    content: string        // The fact itself
    confidence: number     // 0-1, how confident we are
    source: "observed" | "inferred" | "stated"
    sessionID: string
    timestamp: number
  }

  // Extract facts from conversation messages
  export function extract(messages: MessageV2.WithParts[]): Fact[]

  // Store facts (deduplicates automatically)
  export function store(facts: Fact[]): number

  // Retrieve facts relevant to a context
  export function retrieve(context: string, maxFacts?: number): Fact[]

  // Format facts for system prompt injection
  export function format(facts: Fact[], maxChars?: number): string
}
```

**Extraction rules**:

1. **File roles**: When agent reads a file and its think tool mentions "entry point", "config", "utility", "test helper", etc. — extract as file_role fact.

2. **Code patterns**: When agent edits code and the edit follows a pattern (e.g., "all handlers in this project return Response objects") — extract as code_pattern.

3. **Error patterns**: When verification fails and then succeeds — extract the error→fix mapping as error_pattern.

4. **Conventions**: When agent observes naming conventions, import styles, or structural patterns — extract as convention.

5. **Dependencies**: When agent discovers runtime dependencies between files/modules — extract as dependency.

**Compaction hook**: Before compaction runs, `Knowledge.extract()` scans the conversation and stores any new facts. These facts are then available to the next turn via `Knowledge.retrieve()`.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/knowledge/index.ts` | Create | Core knowledge base |
| `src/knowledge/extractor.ts` | Create | Fact extraction from messages |
| `src/session/compaction.ts` | Modify | Call Knowledge.extract before compacting |
| `src/session/prompt.ts` | Modify | Inject relevant facts on step 1 |
| `test/knowledge/knowledge.test.ts` | Create | Tests |

### Success Criteria

- File roles extracted accurately from agent observations
- Error→fix patterns recalled on similar future errors
- Knowledge survives compaction intact
- Retrieval is context-aware (relevant facts ranked higher)
- Total knowledge injection stays within budget (<1000 tokens)

---

## Pillar 26: Project Onboarding

### Problem

First interaction with a new codebase is expensive — 5-10 exploratory reads just to understand the architecture. This knowledge should be built automatically on first encounter and stored permanently.

### Solution

An automatic onboarding protocol that runs on first session with a project, building a structured project model.

### Technical Design

**New module**: `src/onboarding/index.ts`

```typescript
export namespace Onboarding {
  interface ProjectModel {
    name: string
    language: string
    framework?: string
    buildTool: string
    testFramework?: string
    entryPoints: string[]
    keyDirectories: { path: string; role: string }[]
    conventions: string[]
    architecture: string       // 2-3 sentence summary
  }

  // Check if onboarding has been done for this project
  export function isOnboarded(): boolean

  // Run the onboarding protocol
  export async function run(): Promise<ProjectModel>

  // Get the stored project model
  export function getModel(): ProjectModel | undefined

  // Format for system prompt injection
  export function format(model: ProjectModel): string
}
```

**Onboarding protocol** (runs automatically on first session):

1. Read `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` → detect language, deps, scripts
2. Scan directory structure → identify key directories (src/, test/, config/, etc.)
3. Read README if exists → extract architecture description
4. Identify entry points (main files, index files, CLI entry)
5. Detect conventions from first 3-5 source files (naming, imports, patterns)
6. Store as permanent memories via Memory system
7. Format as `<project-model>` block for system prompt

**Integration**: Runs on step 1 if `!Onboarding.isOnboarded()`. Takes ~2-3 seconds. Results are stored as memories so they persist across sessions.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/onboarding/index.ts` | Create | Core onboarding protocol |
| `src/onboarding/detector.ts` | Create | Language/framework detection |
| `src/session/prompt.ts` | Modify | Trigger onboarding on first session |
| `test/onboarding/onboarding.test.ts` | Create | Tests |

### Success Criteria

- Correctly detects language and framework for major ecosystems
- Identifies entry points and key directories
- Produces useful architecture summary
- Runs in <3 seconds
- Stored as permanent memories for recall
- Never re-runs after initial onboarding

---

## Pillar 27: Dry-Run Edits

### Problem

The agent often commits to an edit, runs typecheck, finds errors, and has to fix them — burning 2-3 tool calls on the repair cycle. If it could preview the typecheck result before saving the file, it could adjust the edit before committing.

### Solution

An in-memory edit simulation that applies changes to a temp copy, runs targeted typecheck, and reports results — all without touching the real file.

### Technical Design

**New module**: `src/dryrun/index.ts`

```typescript
export namespace DryRun {
  interface Result {
    wouldSucceed: boolean
    errors: Array<{ file: string; line: number; message: string }>
    warnings: Array<{ file: string; line: number; message: string }>
    duration: number
  }

  // Simulate an edit and check for type errors
  export async function check(
    filePath: string,
    oldContent: string,
    newContent: string,
  ): Promise<Result>

  // Simulate multiple edits atomically
  export async function checkBatch(
    edits: Array<{ filePath: string; oldContent: string; newContent: string }>,
  ): Promise<Result>
}
```

**How it works**:

1. Write the modified content to a temp file (same directory, `.dryrun.tmp` suffix)
2. Run targeted typecheck on just that file: `tsgo --noEmit <tempfile>` or equivalent
3. Parse the output for errors/warnings
4. Delete the temp file
5. Return structured results

**Integration with edit tool**: The edit tool can optionally call `DryRun.check()` before saving. If errors are found, they're included in the edit output so the agent can decide whether to proceed.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/dryrun/index.ts` | Create | Core dry-run engine |
| `src/tool/edit.ts` | Modify | Optional dry-run before save |
| `test/dryrun/dryrun.test.ts` | Create | Tests |

### Success Criteria

- Dry-run catches type errors before they're committed to disk
- Adds <1s overhead to edit operations
- Temp files are always cleaned up
- Works for TypeScript, Go, Rust (language-aware)
- Agent can choose to skip dry-run for simple edits

---

## Pillar 28: Tool Effectiveness Tracking

### Problem

Different projects respond differently to tools. In some codebases, grep finds things instantly; in others, the graph is essential. The agent doesn't learn which tools work best — it uses the same approach every time.

### Solution

Track tool success/failure rates per project and operation type. Use this data to guide tool selection and warn the agent when it's using an ineffective approach.

### Technical Design

**New module**: `src/tool/effectiveness.ts`

```typescript
export namespace ToolEffectiveness {
  interface Record {
    tool: string
    operation?: string       // e.g., "search", "edit", "read"
    success: boolean
    duration: number
    context: string          // Brief context (what was being done)
    timestamp: number
  }

  // Record a tool use outcome
  export function record(entry: Record): void

  // Get effectiveness stats for a tool
  export function stats(tool: string): { successRate: number; avgDuration: number; uses: number }

  // Get the most effective tool for an operation type
  export function recommend(operation: string): string | undefined

  // Format recommendations for system prompt
  export function format(): string
}
```

**How it works**:

1. After each tool call, record success/failure and duration
2. Aggregate stats per tool per project (stored in memory system)
3. On step 1, inject a `<tool-hints>` block with recommendations:
   - "grep is 90% effective for search in this project (avg 200ms)"
   - "graph callers found results 3/4 times for impact analysis"
4. Agent uses this as soft guidance for tool selection

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/tool/effectiveness.ts` | Create | Tool effectiveness tracking |
| `src/session/prompt.ts` | Modify | Inject tool hints on step 1 |
| `test/tool/effectiveness.test.ts` | Create | Tests |

### Success Criteria

- Tracks success/failure per tool per project
- Produces useful recommendations after 10+ tool uses
- Recommendations measurably improve tool selection
- Zero overhead on tool execution (recording is fire-and-forget)
- Stats persist across sessions via memory system

---

## Implementation Order

### Batch 1: Core Capabilities (Pillars 23 + 24)
Runtime Sandbox and Parallel Exploration are independent and provide immediate value.
- **Sandbox** (23): eval/assert/call for testing code behavior
- **Parallel Exploration** (24): fan-out queries for efficient investigation

Estimated: ~1500 lines, 10 new files, ~50 tests

### Batch 2: Knowledge Layer (Pillars 25 + 26)
Knowledge Extraction and Project Onboarding both feed the knowledge base.
- **Knowledge Extraction** (25): structured facts from conversations
- **Project Onboarding** (26): automatic first-encounter model

Estimated: ~1200 lines, 6 new files, ~40 tests

### Batch 3: Optimization (Pillars 27 + 28)
Dry-Run Edits and Tool Tracking are refinements.
- **Dry-Run Edits** (27): simulate edits before committing
- **Tool Tracking** (28): learn which tools work best

Estimated: ~800 lines, 4 new files, ~30 tests

---

## Config Integration

```typescript
experimental: {
  sandbox: boolean              // Pillar 23 (default: true)
  sandbox_timeout: number       // Max eval time in ms (default: 5000)
  parallel_explore: boolean     // Pillar 24 (default: true)
  knowledge_extraction: boolean // Pillar 25 (default: true)
  auto_onboarding: boolean      // Pillar 26 (default: true)
  dryrun_edits: boolean         // Pillar 27 (default: false — opt-in initially)
  tool_tracking: boolean        // Pillar 28 (default: true)
}
```
