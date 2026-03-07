# Phase 7: Agent Mastery II — Development Plan

## Vision

Phases 1-6 gave the agent structure, intelligence, autonomy, and self-monitoring. Phase 7 closes the remaining gaps: understanding code semantics (not just structure), atomic multi-file operations, generating its own tests, adapting mid-session, knowing API signatures from installed packages, and staging edits before committing.

These six pillars address the remaining failure modes: wrong assumptions about code behavior, cascading failures during multi-file refactors, logic errors that pass typecheck, rigid approaches that don't adapt, guessing at API signatures, and broken intermediate states during complex edits.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Loop                              │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Semantic  │→│ Refactor  │→│ Test Gen  │→│ Doc       │   │
│  │ Summary   │  │ Engine    │  │           │  │ Retrieval │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│       ↑              ↑              │              │         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Adaptive  │  │ Edit     │  │ Graph    │  │ Sandbox  │   │
│  │ Tuner     │←│ Staging  │←│ + Cache  │←│ + Verify │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Pillar 29: Semantic Code Summary

### Problem

The knowledge graph captures structural relationships (calls, imports, definitions) but not behavioral meaning. When the agent reads a 200-line function, it burns context understanding it. If semantic summaries were cached, the agent could understand what code does without re-reading it.

### Solution

On-demand function/module summarization that generates concise behavioral descriptions and caches them in the graph. Uses heuristic extraction (JSDoc, docstrings, return types, error throws) plus pattern recognition.

### Technical Design

**New module**: `src/semantic/index.ts`

```typescript
export namespace Semantic {
  interface Summary {
    symbol: string
    filePath: string
    kind: "function" | "class" | "module" | "namespace"
    behavior: string        // 1-2 sentence behavioral description
    inputs: string[]        // Parameter descriptions
    outputs: string         // Return type/value description
    sideEffects: string[]   // File I/O, network, state mutation
    throws: string[]        // Error conditions
    complexity: "simple" | "moderate" | "complex"
  }

  // Generate summary for a symbol from source code
  export function summarize(filePath: string, symbolName: string): Summary | undefined

  // Get cached summary
  export function get(filePath: string, symbolName: string): Summary | undefined

  // Summarize all exports of a file
  export function summarizeFile(filePath: string): Summary[]

  // Format summaries for context injection
  export function format(summaries: Summary[]): string
}
```

**Heuristic extraction**:
1. Parse JSDoc/docstring comments above the function
2. Extract parameter types and return type from signature
3. Scan body for side effects: fs operations, fetch/http, console, DB queries
4. Scan for throw/raise statements
5. Estimate complexity from line count + branching depth
6. Compose behavioral summary from extracted signals

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/semantic/index.ts` | Create | Core semantic summary engine |
| `src/semantic/heuristics.ts` | Create | Extraction heuristics per language |
| `test/semantic/semantic.test.ts` | Create | Tests |

### Success Criteria

- Generates useful summaries for TypeScript/JavaScript functions
- Extracts side effects accurately (file I/O, network, state mutation)
- Summaries are cached and reused across reads
- Works without LLM calls (pure heuristic)
- Summary fits in <200 chars for context injection

---

## Pillar 30: Multi-File Atomic Refactoring

### Problem

Renaming a symbol across 15 files, moving a function and updating imports, changing a type signature — these operations are done file-by-file. If step 8 of 15 fails, the codebase is broken. There's no transaction model for multi-file edits.

### Solution

A refactoring engine that plans the complete set of changes, validates them together, and applies atomically or rolls back.

### Technical Design

**New module**: `src/refactor/index.ts`

```typescript
export namespace Refactor {
  interface Edit {
    filePath: string
    oldContent: string
    newContent: string
  }

  interface Plan {
    id: string
    description: string
    edits: Edit[]
    status: "planned" | "validated" | "applied" | "rolled_back"
    validation?: { success: boolean; errors: string[] }
  }

  // Create a refactoring plan
  export function plan(description: string): Plan

  // Add an edit to the plan
  export function addEdit(planId: string, edit: Edit): void

  // Validate the entire plan (dry-run all edits together)
  export async function validate(planId: string): Promise<Plan>

  // Apply all edits atomically (checkpoint first)
  export async function apply(planId: string): Promise<Plan>

  // Roll back an applied plan
  export async function rollback(planId: string): Promise<Plan>

  // Common refactoring operations
  export async function renameSymbol(
    oldName: string, newName: string, scope?: string[]
  ): Promise<Plan>

  export async function moveFunction(
    fromFile: string, toFile: string, functionName: string
  ): Promise<Plan>

  export async function extractFunction(
    filePath: string, startLine: number, endLine: number, newName: string
  ): Promise<Plan>
}
```

**How it works**:

1. `plan()` creates an empty plan with a checkpoint
2. `addEdit()` stages edits without writing to disk
3. `validate()` writes all edits to temp files, runs typecheck across the set
4. `apply()` writes all edits to real files in one pass, creates git checkpoint
5. `rollback()` restores from checkpoint

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/refactor/index.ts` | Create | Core refactoring engine |
| `src/refactor/operations.ts` | Create | Built-in refactoring operations |
| `src/tool/refactor.ts` | Create | Agent-facing refactor tool |
| `src/tool/registry.ts` | Modify | Register refactor tool |
| `test/refactor/refactor.test.ts` | Create | Tests |

### Success Criteria

- Plans with 10+ edits validate correctly
- Atomic apply: either all edits succeed or none do
- Rollback restores exact original state
- Rename symbol works across imports and references
- Typecheck catches cross-file errors before apply

---

## Pillar 31: Targeted Test Generation

### Problem

Verification catches type errors but not logic errors. The agent can't generate tests for code it just wrote. When a function is created or modified, targeted tests should be auto-generated matching the project's test style.

### Solution

A test generator that analyzes function signatures, identifies edge cases, generates test code matching project conventions, and validates via the sandbox.

### Technical Design

**New module**: `src/testgen/index.ts`

```typescript
export namespace TestGen {
  interface TestCase {
    name: string
    input: string          // Code for the test input
    expected: string       // Expected behavior description
    code: string           // Full test code
  }

  interface TestSuite {
    targetFunction: string
    targetFile: string
    framework: string      // "bun:test" | "jest" | "vitest" | "pytest" | "go_test"
    cases: TestCase[]
    fullCode: string       // Complete test file content
  }

  // Generate tests for a function
  export function generate(
    filePath: string,
    functionName: string,
    functionSource: string,
  ): TestSuite

  // Detect test framework from project
  export function detectFramework(cwd: string): string

  // Generate edge cases from function signature
  export function edgeCases(params: ParamInfo[]): TestCase[]

  // Run generated tests via sandbox
  export async function validate(suite: TestSuite, cwd: string): Promise<{
    passed: number
    failed: number
    errors: string[]
  }>
}
```

**Edge case generation**:
- `string` params → empty string, very long string, special chars
- `number` params → 0, -1, NaN, Infinity, MAX_SAFE_INTEGER
- `boolean` → true, false
- `array` → empty, single element, large array
- `object` → empty object, missing fields, extra fields
- `optional` → undefined, null
- Return type → verify actual return matches declared type

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/testgen/index.ts` | Create | Core test generation engine |
| `src/testgen/edge-cases.ts` | Create | Edge case generators per type |
| `src/testgen/frameworks.ts` | Create | Test framework templates |
| `src/tool/testgen.ts` | Create | Agent-facing test generation tool |
| `src/tool/registry.ts` | Modify | Register testgen tool |
| `test/testgen/testgen.test.ts` | Create | Tests |

### Success Criteria

- Generates valid test files for TypeScript functions
- Detects correct test framework from project
- Edge cases cover null/empty/boundary values
- Generated tests pass sandbox validation
- Matches project test style (imports, describe blocks, etc.)

---

## Pillar 32: Adaptive Session Tuning

### Problem

The strategy engine classifies once. The monitor detects problems. Neither adapts the approach mid-session. If grep fails 3 times, the agent should switch to graph search automatically. If edits keep failing verification, it should think more before acting.

### Solution

A tuning layer that observes tool success patterns within a session and dynamically adjusts tool preferences, think frequency, and approach.

### Technical Design

**New module**: `src/tuning/index.ts`

```typescript
export namespace Tuning {
  interface Adjustment {
    type: "prefer_tool" | "avoid_tool" | "think_more" | "switch_strategy" | "slow_down"
    reason: string
    tool?: string
    newStrategy?: string
  }

  // Analyze recent tool results and suggest adjustments
  export function analyze(sessionID: string): Adjustment[]

  // Get current active adjustments for a session
  export function active(sessionID: string): Adjustment[]

  // Format adjustments for system prompt injection
  export function format(adjustments: Adjustment[]): string

  // Record a tool result for analysis
  export function recordResult(sessionID: string, tool: string, success: boolean): void

  // Clear session state
  export function clear(sessionID: string): void
}
```

**Tuning rules**:
1. **Search pivot**: 3+ failed greps → suggest graph search or explore tool
2. **Verification spiral**: 3+ consecutive verify failures → inject "think before next edit"
3. **Read fatigue**: 5+ reads without an edit → suggest "you may be over-researching"
4. **Tool preference**: If tool X has 80%+ success vs tool Y at 40%, prefer X
5. **Complexity escalation**: If simple approach fails, suggest escalating to planning mode

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/tuning/index.ts` | Create | Core adaptive tuning engine |
| `src/tuning/rules.ts` | Create | Tuning rule definitions |
| `test/tuning/tuning.test.ts` | Create | Tests |

### Success Criteria

- Detects search failure patterns and suggests alternatives
- Detects verification spirals and injects think-first guidance
- Adjustments are injected as `<tuning>` block in system prompt
- Rules are pure heuristics (no LLM calls)
- Adjustments expire after they've been acted on

---

## Pillar 33: Documentation Retrieval

### Problem

The agent sometimes guesses at API signatures from training data. Installed packages have `.d.ts` type declarations with exact signatures. The agent should be able to look these up.

### Solution

Index type declarations from `node_modules` and provide a fast lookup tool for API signatures, method parameters, and type definitions.

### Technical Design

**New module**: `src/docs/index.ts`

```typescript
export namespace Docs {
  interface TypeInfo {
    name: string
    kind: "function" | "class" | "interface" | "type" | "const" | "enum"
    signature: string       // Full type signature
    description?: string    // JSDoc description
    parameters?: Array<{ name: string; type: string; optional: boolean; description?: string }>
    returnType?: string
    source: string          // Package name or file path
  }

  // Index a package's type declarations
  export async function indexPackage(packageName: string, cwd: string): Promise<number>

  // Look up a symbol's type info
  export function lookup(symbol: string, packageName?: string): TypeInfo[]

  // Search for symbols matching a pattern
  export function search(query: string, maxResults?: number): TypeInfo[]

  // Format type info for context injection
  export function format(info: TypeInfo[]): string
}
```

**How it works**:

1. Parse `.d.ts` files from `node_modules/<package>/`
2. Extract exported symbols with their full type signatures
3. Preserve JSDoc comments as descriptions
4. Index by symbol name for fast lookup
5. Cache per package (invalidate on package.json change)

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/docs/index.ts` | Create | Core documentation retrieval engine |
| `src/docs/dts-parser.ts` | Create | .d.ts file parser |
| `src/tool/docs.ts` | Create | Agent-facing docs tool |
| `src/tool/registry.ts` | Modify | Register docs tool |
| `test/docs/docs.test.ts` | Create | Tests |

### Success Criteria

- Indexes common packages (react, express, zod, etc.) in <2s
- Finds exact function signatures by name
- Preserves JSDoc descriptions
- Works for namespaced exports (e.g., `fs.readFile`)
- Cache prevents re-indexing on every lookup

---

## Pillar 34: Edit Staging & Preview

### Problem

Each edit writes to disk immediately. During complex multi-step changes, the codebase is in a broken intermediate state. There's no way to preview the complete diff before any changes touch the filesystem.

### Solution

A staging area where edits accumulate in memory. The agent can add, review, adjust, and diff staged edits, then apply all at once or discard.

### Technical Design

**New module**: `src/staging/index.ts`

```typescript
export namespace Staging {
  interface StagedEdit {
    id: string
    filePath: string
    originalContent: string
    newContent: string
    description: string
    timestamp: number
  }

  interface Stage {
    id: string
    edits: StagedEdit[]
    status: "open" | "applied" | "discarded"
  }

  // Create a new staging area
  export function create(description?: string): Stage

  // Add an edit to the stage
  export function add(stageId: string, filePath: string, newContent: string, description: string): void

  // Preview the full diff of all staged edits
  export function diff(stageId: string): string

  // Preview a single file's changes
  export function fileDiff(stageId: string, filePath: string): string

  // Apply all staged edits to disk
  export async function apply(stageId: string): Promise<{ applied: number; errors: string[] }>

  // Discard all staged edits
  export function discard(stageId: string): void

  // Remove a specific edit from the stage
  export function remove(stageId: string, editId: string): void

  // List all stages
  export function list(): Stage[]
}
```

**Diff generation**: Uses unified diff format, showing file-by-file changes with context lines. The full diff can be shown to the user for review before applying.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/staging/index.ts` | Create | Core staging engine |
| `src/tool/staging.ts` | Create | Agent-facing staging tool |
| `src/tool/registry.ts` | Modify | Register staging tool |
| `test/staging/staging.test.ts` | Create | Tests |

### Success Criteria

- Edits accumulate without touching disk
- Full unified diff shows all pending changes
- Apply writes all files in one pass
- Discard cleanly removes all staged edits
- Works with the refactor engine (Pillar 30)

---

## Implementation Order

### Batch 1: Core Capabilities (Pillars 29 + 30)
Semantic Summary and Atomic Refactoring are independent and high-impact.
- **Semantic Summary** (29): heuristic code understanding
- **Atomic Refactoring** (30): multi-file transaction model

Estimated: ~1200 lines, 8 new files, ~50 tests

### Batch 2: Generation & Retrieval (Pillars 31 + 33)
Test Generation and Docs Retrieval both improve correctness.
- **Test Generation** (31): auto-generate targeted tests
- **Docs Retrieval** (33): look up real API signatures

Estimated: ~1400 lines, 10 new files, ~50 tests

### Batch 3: Adaptation & Staging (Pillars 32 + 34)
Adaptive Tuning and Edit Staging are refinements.
- **Adaptive Tuning** (32): mid-session approach adjustment
- **Edit Staging** (34): preview before committing

Estimated: ~900 lines, 6 new files, ~40 tests

---

## Config Integration

```typescript
experimental: {
  semantic_summary: boolean        // Pillar 29 (default: true)
  atomic_refactor: boolean         // Pillar 30 (default: true)
  test_generation: boolean         // Pillar 31 (default: true)
  adaptive_tuning: boolean         // Pillar 32 (default: true)
  docs_retrieval: boolean          // Pillar 33 (default: true)
  edit_staging: boolean            // Pillar 34 (default: false — opt-in)
}
```
