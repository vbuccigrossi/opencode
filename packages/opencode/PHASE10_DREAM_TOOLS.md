# Phase 10: Dream Tools

**Focus**: Close the three remaining gaps between a good agent and a great one.

## Pillar 41: Auto-Test After Edit

**Problem**: The verify loop catches type errors after edits, but doesn't run the
relevant tests. The graph already has `tested_by` edges and test file detection —
the last-mile wiring is missing.

### Design
- After typecheck passes in the verify loop, query graph for `tested_by` edges
  on all edited files/entities
- Run matched test files via the verify engine
- If tests fail, inject as `<verification-errors>` just like typecheck failures
- Respects `experimental.auto_verify_test` config flag (already exists, not wired)
- Limits: max 5 test files per cycle, 30s timeout per file

### Modules
- `src/verify/auto-test.ts` — Test discovery + execution bridge
- Wired into `src/verify/loop.ts`

---

## Pillar 42: Atomic Change Sets

**Problem**: Multi-file edits happen one at a time. Intermediate states can be
inconsistent. Staging is per-file — there's no way to preview or apply a coherent
multi-file change as a single unit.

### Design
- A changeset accumulates file edits (original + proposed content)
- Preview shows a unified multi-file diff
- Apply writes all files atomically (or rolls back on failure)
- Rollback restores all files to their original content
- Change sets are named and tracked in memory

### Modules
- `src/changeset/index.ts` — Core: create, addEdit, remove, preview, apply, rollback, discard
- `src/tool/changeset.ts` — Agent tool with operations

### Operations
- `create`: Start a new named change set
- `add`: Add a file edit to the change set
- `remove`: Remove a file from the change set
- `preview`: Show unified diff of all changes
- `apply`: Write all files atomically
- `rollback`: Restore all files to originals
- `list`: List active change sets
- `status`: Show summary of a change set

---

## Pillar 43: Real-Time Correction Learning

**Problem**: Memory captures cross-session patterns, but within a single session,
the agent doesn't structurally track when the user corrects its approach. Repeated
corrections on the same topic should amplify the signal.

### Design
- Scan user messages for correction signals (negation, redirection, preference)
- Extract the correction and categorize it (approach, style, scope, tool_use, output)
- Maintain a session-local corrections list with strength (repeated = stronger)
- Inject into system prompt as `<corrections>` block so the agent stays aligned
- Passive — no tool needed, runs automatically on every user message

### Modules
- `src/correction/index.ts` — Detection, extraction, tracking, formatting
- Wired into `src/session/prompt.ts`

### Detection Signals
- Negation: "no", "don't", "stop", "not what I asked"
- Redirection: "instead", "actually", "I meant", "rather"
- Preference: "always", "never", "prefer", "I like/hate"
- Frustration: "I already said", "again", "wrong", "that's not"

---

## Implementation Order

**Batch 1**: Auto-Test (41) + Correction Learning (43) — independent, parallel
**Batch 2**: Atomic Change Sets (42) — standalone

## Test Targets
- Auto-Test: ~15 tests (discovery, graph wiring, execution, limits)
- Change Sets: ~20 tests (lifecycle, diff preview, atomic apply/rollback)
- Corrections: ~15 tests (signal detection, extraction, formatting, dedup)
- Total: ~50 tests
