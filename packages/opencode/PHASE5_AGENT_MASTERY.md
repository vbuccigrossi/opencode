# Phase 5: Agent Mastery — Development Plan

## Vision

Build the best coding agent possible by solving the fundamental failure modes that limit agent effectiveness. These six pillars address the root causes of wasted context, lost state, blind editing, and repetitive mistakes.

**Phases 1-4 gave the agent capabilities.** Phase 5 gives it *intelligence*.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Prompt Loop                        │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Strategy  │→│ Pre-Flight│→│ Tool Execution     │  │
│  │ Engine    │  │ Validator │  │ (edit, bash, etc.) │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│       ↑              ↑               │               │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Session   │  │ Dynamic  │  │ Meta-Cognitive   │   │
│  │ State     │←│ Context  │←│ Monitor          │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
│       ↑                              │               │
│  ┌──────────────────────────────────────────────┐    │
│  │         Cross-Session Intelligence            │    │
│  │  (Memory + Strategy Memories + Patterns)      │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

All six pillars integrate into the existing prompt loop (`src/session/prompt.ts`) and processor (`src/session/processor.ts`). No architectural rewrites — each pillar adds a new module that hooks into well-defined extension points.

---

## Pillar 17: Structured Session State

### Problem

Compaction converts a rich conversation into a prose summary. This is fundamentally lossy — the *structure* of what the agent was doing (goals, plans, decisions, working files, failed approaches) gets flattened into narrative text. The next turn starts with vague awareness rather than precise situational understanding.

### Solution

A persistent, structured state object that the agent maintains throughout the session. On compaction, this object is preserved verbatim — no summarization needed.

### Technical Design

**New module**: `src/session/state.ts`

```typescript
export namespace SessionState {
  export interface State {
    version: 1
    goal: string
    plan: PlanStep[]
    workingSet: string[]
    decisions: Decision[]
    invariants: string[]
    failedApproaches: FailedApproach[]
    checkpoint?: string
    metadata: Record<string, unknown>
  }

  interface PlanStep {
    id: string
    step: string
    status: "pending" | "active" | "done" | "failed" | "skipped"
    notes?: string
    dependencies?: string[]  // IDs of steps this depends on
  }

  interface Decision {
    choice: string
    reason: string
    alternatives?: string[]
    timestamp: number
  }

  interface FailedApproach {
    approach: string
    reason: string
    timestamp: number
  }
}
```

**New tool**: `src/tool/state.ts`

Operations:
- `init` — Set the goal and initial plan from user request analysis
- `update_plan` — Mark steps as done/failed, add new steps
- `add_decision` — Record a decision with reasoning
- `add_invariant` — Record a constraint that must hold
- `record_failure` — Record an approach that didn't work
- `set_checkpoint` — Create a git stash checkpoint
- `get` — Read current state (for agent self-reference)
- `update_working_set` — Add/remove files from working set

**System prompt injection**: On every step, inject `<session-state>` block containing the current state JSON. This is compact (typically 500-2000 tokens) and gives perfect situational awareness.

**Compaction integration**: The state tool is added to `PRUNE_PROTECTED_TOOLS` in `compaction.ts`. State tool calls survive compaction because the state is in the tool *input* (like the think tool pattern). Additionally, the compaction summary prompt includes the current state object so the summary agent can reference it.

**Agent instructions**: The system prompt instructs the agent to:
1. Call `state.init` at the start of any non-trivial task
2. Update the plan as steps complete
3. Record decisions when facing ambiguous choices
4. Record failed approaches so they aren't retried
5. The state is the agent's "working memory" — if it matters, put it in the state

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/session/state.ts` | Create | Core state module (schema, get/set, format) |
| `src/tool/state.ts` | Create | Agent-facing state tool |
| `src/session/prompt.ts` | Modify | Inject `<session-state>` on every step |
| `src/session/compaction.ts` | Modify | Protect state tool, include state in summary prompt |
| `src/tool/registry.ts` | Modify | Register state tool |
| `src/session/state.sql.ts` | Create | DB schema for state persistence |
| `test/session/state.test.ts` | Create | Tests |

### Success Criteria

- State survives compaction intact
- Agent correctly initializes state at task start
- After compaction, the agent continues without losing track of what it was doing
- State is compact enough (<2000 tokens) to not burden the context window
- Failed approaches are never retried within the same session

---

## Pillar 18: Dynamic Context Window

### Problem

The context pipeline (`src/context/`) runs once at step 1 using the user's initial message. By step 15, the agent may be working on completely different files. It reads files manually, burning context on tool calls when the system could have proactively provided what's needed.

### Solution

Make context selection reactive — it evolves based on what the agent is actually doing, not just what the user asked for initially.

### Technical Design

**New module**: `src/context/dynamic.ts`

```typescript
export namespace DynamicContext {
  interface WorkingSet {
    files: Map<string, {
      relevance: number      // 0-1, decays over steps
      lastAccessed: number   // step number
      reason: string         // why this file is relevant
    }>
    maxTokens: number
  }

  // Called after each tool result
  export function onToolResult(result: ToolResult): ContextUpdate

  // Called at the start of each step
  export function getInjection(state: SessionState, budget: number): string

  // Expand working set based on graph relationships
  export function expandFromGraph(files: string[]): string[]
}
```

**How it works**:

1. **After each edit**: Query the graph for callers/callees of modified entities. Score them. Add high-scoring files to the working set.

2. **After verification errors**: Parse error locations. Add referenced files to the working set with high relevance.

3. **After file reads**: Add the file and its direct neighbors to the working set.

4. **Relevance decay**: Every step, decay relevance scores by 0.9x. Files that haven't been accessed in 5+ steps drop out automatically.

5. **Budget-aware injection**: On each step, select the top-N files from the working set that fit within the token budget. Inject as a `<dynamic-context>` block with file summaries (first 20 lines + function signatures, not full content).

6. **Integration with Session State**: The working set syncs with `state.workingSet` — the agent can also manually add/remove files.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/context/dynamic.ts` | Create | Core dynamic context module |
| `src/context/working-set.ts` | Create | Working set management with decay |
| `src/session/prompt.ts` | Modify | Call `DynamicContext.getInjection()` on every step (not just step 1) |
| `src/session/prompt.ts` | Modify | Hook `DynamicContext.onToolResult()` after tool execution |
| `test/context/dynamic.test.ts` | Create | Tests |

### Success Criteria

- When the agent edits file A, callers of A appear in context on the next step without the agent requesting them
- Verification errors automatically bring relevant files into context
- Files not accessed in 5+ steps are evicted
- Total dynamic context stays within budget (default: 40% of injection budget)
- Measurably fewer "read file" tool calls needed per task

---

## Pillar 19: Pre-Flight Validation & Checkpoints

### Problem

The agent edits files and discovers problems only after the fact via the verify loop. For multi-file changes, a failure at step 3 of 5 leaves the codebase in a half-modified state that's hard to recover from.

### Solution

Two complementary mechanisms:
1. **Pre-flight analysis**: Before executing changes, analyze the blast radius
2. **Checkpoints**: Automatic git-based save points before risky operations

### Technical Design

**Pre-flight module**: `src/session/preflight.ts`

```typescript
export namespace PreFlight {
  interface Analysis {
    filesTouched: string[]
    callersAffected: number
    testsAffected: string[]
    riskLevel: "low" | "medium" | "high"
    warnings: string[]
  }

  // Analyze impact before a planned change
  export async function analyze(changes: PlannedChange[]): Promise<Analysis>

  // Generate a summary for the agent
  export function summarize(analysis: Analysis): string
}
```

**Checkpoint module**: `src/session/checkpoint.ts`

```typescript
export namespace Checkpoint {
  // Create a checkpoint before risky operations
  export async function create(sessionID: string, label: string): Promise<string>

  // Rollback to a checkpoint
  export async function rollback(sessionID: string, ref: string): Promise<void>

  // List available checkpoints
  export async function list(sessionID: string): Promise<CheckpointInfo[]>

  // Auto-checkpoint: called by edit/write tools when risk is high
  export async function autoCheckpoint(ctx: ToolContext, analysis: Analysis): Promise<void>
}
```

**Integration points**:

1. **Edit tool enhancement**: Before applying edits to >2 files, run pre-flight analysis. If riskLevel is "high", create an automatic checkpoint.

2. **State tool integration**: Checkpoints are recorded in `state.checkpoint`. On failure, the agent can reference this to decide whether to rollback.

3. **Verify loop integration**: If verification fails after a checkpointed change, inject a message: "Verification failed. Checkpoint available at {ref}. Consider rolling back."

**Risk classification**:
- **Low**: Single file, <10 lines changed, no callers affected
- **Medium**: 2-3 files, or function signatures changed with <5 callers
- **High**: 4+ files, or function signatures changed with 5+ callers, or changes to exported interfaces

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/session/preflight.ts` | Create | Pre-flight impact analysis |
| `src/session/checkpoint.ts` | Create | Git-based checkpoints |
| `src/tool/edit.ts` | Modify | Add pre-flight hook before multi-file edits |
| `src/verify/loop.ts` | Modify | Offer rollback on verification failure |
| `src/session/state.ts` | Modify | Track checkpoints in session state |
| `test/session/preflight.test.ts` | Create | Tests |
| `test/session/checkpoint.test.ts` | Create | Tests |

### Success Criteria

- High-risk changes always have a checkpoint
- Agent can rollback cleanly when verification fails
- Pre-flight analysis completes in <500ms (uses cached graph data)
- No half-broken states after failed multi-file changes
- Agent never retries an approach that already failed (uses state.failedApproaches)

---

## Pillar 20: Strategy Engine

### Problem

The agent uses the same approach for every task — jump in, start reading/editing, react to errors. But a simple rename needs grep+edit while a complex refactor needs planning, staged edits, and incremental verification. Using the wrong strategy wastes context and produces worse results.

### Solution

Classify the task, select an appropriate strategy, and adapt mid-session based on results.

### Technical Design

**New module**: `src/strategy/`

```
src/strategy/
  index.ts        — Public API
  classifier.ts   — Task classification
  strategies.ts   — Strategy definitions
  executor.ts     — Strategy-aware execution hints
```

**Task classifier**: `src/strategy/classifier.ts`

Analyzes the user's message + session state to classify the task:

```typescript
export type TaskType =
  | "simple_edit"      // Change a few lines in 1-2 files
  | "bug_fix"          // Diagnose and fix a problem
  | "feature"          // Add new functionality
  | "refactor"         // Restructure existing code
  | "exploration"      // Understand code, answer questions
  | "test"             // Write or fix tests
  | "review"           // Code review, security audit

export function classify(userMessage: string, state?: SessionState): TaskType
```

Classification uses keyword matching + structural analysis (not LLM calls — must be fast). Falls back to "feature" for ambiguous cases.

**Strategy definitions**: `src/strategy/strategies.ts`

Each strategy is a set of behavioral hints injected into the system prompt:

```typescript
interface Strategy {
  type: TaskType
  prelude: string[]         // Steps to take before main work
  editMode: "direct" | "staged" | "cautious"
  verifyFrequency: "after_all" | "after_each" | "after_batch"
  checkpointPolicy: "never" | "auto" | "always"
  subagentPolicy: "never" | "for_exploration" | "for_alternatives"
  maxFilesBeforeCheckpoint: number
  thinkFirst: boolean       // Whether to use think tool before acting
}
```

**Built-in strategies**:

| Task Type | Edit Mode | Verify | Checkpoint | Think First |
|-----------|-----------|--------|------------|-------------|
| simple_edit | direct | after_all | never | no |
| bug_fix | direct | after_each | auto | yes |
| feature | staged | after_batch | auto | yes |
| refactor | cautious | after_each | always | yes |
| exploration | N/A | never | never | yes |
| test | direct | after_all | auto | no |
| review | N/A | never | never | yes |

**Prompt injection**: The active strategy is injected as a `<strategy>` block in the system prompt. It doesn't force behavior — it *guides* it. The agent can deviate if circumstances warrant.

**Mid-session adaptation**: If the initial strategy isn't working (e.g., verification keeps failing), the monitor (Pillar 21) can suggest switching strategies. This is recorded as a decision in the session state.

**Memory integration**: After successful task completion, store a strategy memory: "For refactoring TypeScript type hierarchies in this project, cautious/staged worked well." On future similar tasks, recall and apply.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/strategy/index.ts` | Create | Public API |
| `src/strategy/classifier.ts` | Create | Task classification |
| `src/strategy/strategies.ts` | Create | Strategy definitions |
| `src/strategy/executor.ts` | Create | Execution hints |
| `src/session/prompt.ts` | Modify | Inject strategy block, classify on step 1 |
| `src/memory/index.ts` | Modify | Add "strategy" memory type |
| `test/strategy/classifier.test.ts` | Create | Tests |
| `test/strategy/strategies.test.ts` | Create | Tests |

### Success Criteria

- Tasks are correctly classified >80% of the time
- Refactors use checkpoints; simple edits don't
- Strategy hints measurably reduce wasted tool calls
- Strategy memories are recalled for similar future tasks
- Mid-session strategy switches happen when initial approach fails

---

## Pillar 21: Meta-Cognitive Monitor

### Problem

The agent has no self-awareness about its own performance during a session. It doesn't know if it's going in circles, burning context on unproductive work, or drifting from the goal. The doom loop detector (3x identical tool calls) is too crude and triggers too late.

### Solution

A lightweight heuristic monitor that runs between steps and provides feedback to the agent via the system prompt.

### Technical Design

**New module**: `src/monitor/`

```
src/monitor/
  index.ts        — Public API
  patterns.ts     — Pattern detection (circles, waste, drift)
  budget.ts       — Context budget tracking
  signals.ts      — Signal definitions and thresholds
```

**Core signals** tracked per-step:

```typescript
interface MonitorState {
  stepCount: number
  tokensBurned: number
  tokensRemaining: number       // estimated
  uniqueFilesRead: Set<string>
  filesReadMultipleTimes: Map<string, number>
  editAttempts: Map<string, number>  // file → edit count
  verificationFailures: number
  consecutiveFailures: number
  toolCallHistory: string[]     // last 20 tool names
  goalDriftScore: number        // 0-1, how far from original goal
}
```

**Pattern detectors**: `src/monitor/patterns.ts`

1. **Circular edits**: Same file edited 3+ times → "You've edited {file} {n} times. Step back and reconsider your approach."

2. **Redundant reads**: Same file read 3+ times → "You've already read {file}. The content hasn't changed."

3. **Verification spiral**: 3+ consecutive verification failures → "Verification has failed {n} times. Consider rolling back to checkpoint and trying a different approach."

4. **Context burn rate**: If >50% of estimated context is consumed by step 5 → "You've used {n}% of context by step {s}. Be concise and focused."

5. **Goal drift**: Compare recent tool calls against session state goal → "Your recent actions don't seem related to the goal: {goal}. Are you on track?"

6. **Unproductive reads**: Files read but never referenced in edits → "You read {n} files that you haven't used. Consider being more targeted."

**Output format**: A compact `<monitor>` block injected into the system prompt when any signal exceeds its threshold:

```xml
<monitor>
- Context: 62% used (step 8 of ~25 estimated)
- Warning: file.ts edited 3 times — consider a different approach
- Checkpoint available: stash@{0} (created step 4)
</monitor>
```

When no signals fire, the block is omitted (zero overhead).

**Integration**: Runs as a synchronous post-step hook in `prompt.ts`. No LLM calls — pure heuristics. Should add <1ms per step.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/monitor/index.ts` | Create | Public API, state management |
| `src/monitor/patterns.ts` | Create | Pattern detection heuristics |
| `src/monitor/budget.ts` | Create | Context budget tracking |
| `src/monitor/signals.ts` | Create | Signal definitions and thresholds |
| `src/session/prompt.ts` | Modify | Call monitor after each step, inject block |
| `test/monitor/patterns.test.ts` | Create | Tests |
| `test/monitor/budget.test.ts` | Create | Tests |

### Success Criteria

- Circular edit patterns detected before the 3rd repetition
- Context budget warnings appear at 50%, 75%, 90%
- Goal drift detected when agent goes off-track for 3+ consecutive steps
- Zero performance overhead (heuristic-only, no LLM calls)
- Monitor output is compact (<200 tokens when active, 0 when inactive)

---

## Pillar 22: Cross-Session Intelligence

### Problem

The memory system stores facts ("this project uses bun", "the auth module is in src/auth"). But it doesn't store *how to work* — which strategies succeeded, which error patterns have known fixes, which files are most important. Each new session starts with facts but no expertise.

### Solution

Extend the memory system to capture and recall working strategies, error-fix patterns, and file familiarity — building genuine project expertise over time.

### Technical Design

**New memory types** (added to existing `src/memory/`):

```typescript
// Existing types: pattern, architecture, debugging, preference, convention

// New types:
type MemoryType =
  | "strategy"      // "Refactoring types in this project works best with staged edits"
  | "error_fix"     // "When tsgo reports TS2345, check the type narrowing in the caller"
  | "file_expertise" // "src/session/prompt.ts is the main prompt loop, ~1800 lines, heavily modified"
```

**Auto-extraction hooks**: `src/memory/auto-extract.ts`

Runs at the end of each successful task (when the agent stops with a completed state):

```typescript
export namespace AutoExtract {
  // Extract strategy insight from completed session
  export function fromSession(state: SessionState, messages: MessageV2[]): MemoryCandidate[]

  // Extract error-fix pattern from successful repair
  export function fromRepair(error: string, fix: string): MemoryCandidate | null

  // Update file expertise from session activity
  export function updateFileExpertise(workingSet: string[], edits: string[]): void
}
```

**Strategy extraction**: When a task completes successfully:
1. Look at the session state's task type + strategy used
2. If verification passed on first try → strong positive signal
3. If strategy was switched mid-session → record what worked and what didn't
4. Store as a strategy memory: "For {task_type} in {project_area}, {strategy} worked well because {reason}"

**Error-fix extraction**: When the verify loop successfully repairs an error:
1. Capture the error message pattern (generalized, not specific line numbers)
2. Capture what the fix was (file + nature of change)
3. Store as an error_fix memory
4. On future similar errors, recall the fix pattern

**File expertise**: Track across sessions:
- How many times each file has been read/edited
- Whether edits to a file typically succeed or fail
- What the file's role is (entry point, utility, config, test)
- Store as file_expertise memories for high-traffic files

**Recall integration**: On step 1, when building context:
1. Check if the task type has matching strategy memories → inject as guidance
2. Check if recent errors match known error_fix patterns → inject as hints
3. Weight context selection using file expertise → prioritize familiar files

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/memory/auto-extract.ts` | Create | Automatic insight extraction |
| `src/memory/index.ts` | Modify | Add strategy/error_fix/file_expertise types |
| `src/session/prompt.ts` | Modify | Inject strategy memories on step 1 |
| `src/verify/loop.ts` | Modify | Call AutoExtract.fromRepair on successful repairs |
| `src/context/scorer.ts` | Modify | Use file expertise in scoring |
| `test/memory/auto-extract.test.ts` | Create | Tests |

### Success Criteria

- Successful strategies are automatically captured and recalled
- Error-fix patterns reduce repeat verification failures across sessions
- File expertise improves context selection accuracy over time
- Memory consolidation prevents unbounded growth
- Agent demonstrably improves at a project over multiple sessions

---

## Implementation Order

### Batch 1: Foundation (Pillars 17 + 18 + 21)

These three are tightly coupled and form the foundation for everything else:
- **Session State** (17) provides the structured goal/plan that Dynamic Context and Monitor both reference
- **Dynamic Context** (18) uses the working set from Session State
- **Meta Monitor** (21) tracks progress against the Session State goal

Estimated scope: ~2000 lines across 12 new files + 5 modified files.

### Batch 2: Safety (Pillar 19)

Pre-flight validation and checkpoints. Depends on Session State (stores checkpoints) and Monitor (triggers rollback suggestions).

Estimated scope: ~800 lines across 4 new files + 3 modified files.

### Batch 3: Intelligence (Pillars 20 + 22)

Strategy Engine and Cross-Session Intelligence. Depends on Session State (task classification feeds into state), Monitor (triggers strategy switches), and Memory (stores/recalls strategies).

Estimated scope: ~1200 lines across 8 new files + 4 modified files.

---

## Config Integration

All features are controlled via `experimental` config:

```typescript
experimental: {
  session_state: boolean          // Pillar 17 (default: true)
  dynamic_context: boolean        // Pillar 18 (default: true)
  dynamic_context_budget: number  // Max tokens for dynamic context (default: 40% of injection budget)
  preflight: boolean              // Pillar 19 (default: true)
  auto_checkpoint: boolean        // Pillar 19 (default: true)
  strategy_engine: boolean        // Pillar 20 (default: true)
  meta_monitor: boolean           // Pillar 21 (default: true)
  cross_session_learning: boolean // Pillar 22 (default: true)
  monitor_thresholds: {
    context_warn_percent: number  // Default: 50
    circular_edit_count: number   // Default: 3
    consecutive_failures: number  // Default: 3
    goal_drift_steps: number      // Default: 3
  }
}
```

---

## Testing Strategy

Each pillar gets its own test directory under `test/`:

| Pillar | Test File(s) | Estimated Tests |
|--------|-------------|-----------------|
| 17 | `test/session/state.test.ts` | 20 |
| 18 | `test/context/dynamic.test.ts`, `test/context/working-set.test.ts` | 25 |
| 19 | `test/session/preflight.test.ts`, `test/session/checkpoint.test.ts` | 20 |
| 20 | `test/strategy/classifier.test.ts`, `test/strategy/strategies.test.ts` | 25 |
| 21 | `test/monitor/patterns.test.ts`, `test/monitor/budget.test.ts` | 25 |
| 22 | `test/memory/auto-extract.test.ts` | 15 |
| **Total** | | **~130** |

All tests use the existing fixture patterns (Instance.provide, tmpdir, mock ctx). No external dependencies.

---

## Estimated Total Scope

| Metric | Count |
|--------|-------|
| New files | ~24 |
| Modified files | ~12 |
| New lines (est.) | ~4,000 |
| New tests (est.) | ~130 |
| New tools | 1 (state) |
| New system prompt blocks | 3 (session-state, dynamic-context, monitor) |

This brings the total project additions to:
- **Pillars**: 22 (16 complete + 6 new)
- **Tests**: ~510+ (380 existing + 130 new)
- **Custom tools**: 40+
