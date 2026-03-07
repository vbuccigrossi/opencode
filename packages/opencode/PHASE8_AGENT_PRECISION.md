# Phase 8: Agent Precision

**Focus**: Remove the three highest-friction pain points from real agent sessions.

## Pillar 35: Signature Cascade Engine

**Problem**: When a function signature changes, the agent must manually visit every
caller — read file, edit it, verify — 3-4 tool calls per affected file. For 12 callers,
that's 40+ mechanical tool calls.

**Solution**: A cascade engine that uses the knowledge graph to find all callers,
generates the required edits automatically, and applies them atomically.

### Modules
- `src/cascade/index.ts` — Public API: `Cascade.plan()`, `Cascade.apply()`, `Cascade.preview()`
- `src/cascade/transforms.ts` — Call-site transformers: add/remove/reorder/rename parameters
- `src/tool/cascade.ts` — Agent-facing tool: `cascade` with operations: plan, preview, apply

### Design
1. Agent calls `cascade plan` with:
   - `symbol_name`: the function that changed
   - `transform`: what changed (e.g., "add_param", "remove_param", "rename_param")
   - `details`: transform-specific args (position, name, default value, etc.)
2. Engine queries `Graph.callersOf()` to find all call sites
3. For each caller, reads the file and applies the transform to every call expression
4. Returns a preview showing each file + the exact edit
5. Agent reviews and calls `cascade apply` to write all edits atomically

### Transforms
- `add_param` — Insert a new argument at position N with a default value
- `remove_param` — Remove argument at position N from all call sites
- `rename_param` — Rename named argument (for object-style params)
- `reorder_params` — Reorder arguments to match new signature
- `change_type` — Type-level change (no call-site edits needed, but documents affected files)

---

## Pillar 36: Context Resumption Protocol

**Problem**: After compaction, the agent loses nuance about what it was doing mid-task.
It re-reads files it already analyzed, retraces decisions, and wastes tool calls
recovering context that was just cleared.

**Solution**: A resumption protocol that snapshots the agent's working context before
compaction and provides a structured `<resumption>` block after compaction that tells
the agent exactly where it left off.

### Modules
- `src/session/resumption.ts` — Public API: `Resumption.snapshot()`, `Resumption.restore()`, `Resumption.format()`

### Design
1. Before compaction: `snapshot()` captures:
   - Current session state (goal, plan, active step, working set)
   - Recent file modifications (from changelog)
   - Last 3 scratchpad thoughts
   - Active verification errors
   - In-progress tool calls
2. After compaction: `restore()` builds a `<resumption>` block:
   - "You were working on: [goal]"
   - "Current step: [active plan step]"
   - "Files recently modified: [list with +/- line counts]"
   - "Last thoughts: [condensed scratchpad]"
   - "Pending issues: [verification errors if any]"
3. Injected into system prompt on the first step after compaction

### Key insight
The snapshot is stored as a single JSON blob in memory (not in messages), so it
survives compaction. The format is compact enough to fit in ~500 tokens.

---

## Pillar 37: Structured Test Result Parser

**Problem**: When tests fail, the verify engine gives raw output. Parsing 200 lines of
test output to find 3 failures is slow and error-prone. The agent needs structured
results: test name, status, assertion details, source location.

**Solution**: A dedicated test result parser that understands the output format of each
major test runner and produces structured `TestResult` objects.

### Modules
- `src/verify/test-parser.ts` — Parser: `TestParser.parse()` with per-framework parsers
- `src/verify/test-parser.ts` — Also: `TestParser.format()` for compact output

### Supported Frameworks
- **Bun test**: Parse `(pass)`, `(fail)` markers, `error: expect()` blocks
- **Jest/Vitest**: Parse `PASS`/`FAIL` markers, assertion error blocks
- **pytest**: Parse `PASSED`/`FAILED`/`ERROR` with `::test_name` format
- **Go test**: Parse `--- PASS`/`--- FAIL` with `TestName` format

### Test Result Schema
```typescript
interface TestResult {
  name: string             // Full test name (describe > test)
  status: "pass" | "fail" | "error" | "skip"
  duration?: number        // ms
  file?: string            // Test file path
  line?: number            // Failure line
  assertion?: {
    expected?: string      // What was expected
    received?: string      // What was received
    operator?: string      // toBe, toEqual, etc.
    message?: string       // Full assertion message
  }
}
```

### Format output
Instead of raw test output, the agent sees:
```
3 of 50 tests failed:

FAIL src/math.test.ts > add > handles negative numbers
  Line 15: expect(add(-1, -2)).toBe(-3)
  Expected: -3
  Received: 3

FAIL src/math.test.ts > subtract > handles zero
  Line 28: expect(subtract(5, 0)).toBe(5)
  Expected: 5
  Received: 0
```

---

## Implementation Order

**Batch 1**: Cascade Engine (Pillar 35) + Test Result Parser (Pillar 37)
- Independent modules, can be built and tested in parallel
- Cascade depends on graph; test parser is standalone

**Batch 2**: Context Resumption (Pillar 36)
- Depends on session state, scratchpad, changelog — all existing
- Integration point: compaction hook in `src/session/compaction.ts`

## Test Targets
- Cascade: ~25 tests (transforms, graph integration, preview/apply)
- Test Parser: ~25 tests (per-framework parsing, format output)
- Resumption: ~15 tests (snapshot, restore, format)
- Total: ~65 tests
