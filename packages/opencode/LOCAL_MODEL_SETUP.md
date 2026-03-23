# Local Model Setup — Offline Security Research Agent

Run cortex with a local ollama model for air-gapped / travel use. No cloud
APIs, no internet required after initial setup.

## Architecture

```
cortex (bun/TypeScript)
  ├── ollama provider ──→ devstral-16k (24B, 16K context)
  ├── embedding provider ──→ nomic-embed-text (768-dim)
  ├── RAG index ──→ ~/work/ (security research corpus)
  │     ├── CVE projects (Go exploit code, rules, writeups)
  │     └── .docs/ (generated Go API documentation)
  └── error-aware RAG ──→ auto-injects docs on build failures
```

## What's Customized

### Reduced System Prompt

Ollama models get a stripped-down prompt path in `src/session/prompt.ts`:
- No MCP servers (tool schemas overflow context)
- No CLAUDE.md / AGENTS.md (host-specific, wastes tokens)
- Only user-specified `instructions` files are loaded
- RAG context cached across tool-call loops (model can't re-fetch)

### RAG Pipeline

`src/embedding/rag.ts` indexes `~/work/` into SQLite with hybrid search:
- Vector similarity (nomic-embed-text embeddings)
- FTS5 keyword matching (exact CVE IDs, package names)
- Query expansion for entity-specific sub-queries

Security metadata extraction (`src/embedding/metadata-extract.ts`) categorizes
chunks as detection-rule / exploit / writeup / code / documentation and enriches
FTS with CVE IDs, ATT&CK IDs, severity.

### Error-Aware RAG (Phase 11)

`src/embedding/error-rag.ts` — when a bash command fails with compilation
errors, the system automatically:
1. Extracts package names, symbols, and error messages from compiler output
2. Searches RAG for relevant API documentation (1-3 queries)
3. Injects an `<error-context>` block into the next step's system prompt
4. Clears after one injection (doesn't persist if the error is fixed)

Supports Go, Rust, Python, TypeScript, and C/C++ error formats. Only fires for
ollama models — cloud models can reason about errors without docs.

### Documentation Dataset

`scripts/build-go-docs.py` generates structured markdown from Go packages for
RAG indexing. Output goes into `~/work/.docs/` which the crawler picks up
automatically.

```
~/work/.docs/
  go-stdlib/         63 files — net/http, crypto/tls, encoding/json, ...
  go-modules/        37 files — READMEs from go.sum dependencies
  go-exploit-api/    30 files — go doc -all for every go-exploit subpackage
  error-patterns/     1 file  — Go compilation error reference
```

Each file has YAML frontmatter (`type: documentation`) so the metadata
extractor categorizes them correctly and RAG search ranks them appropriately.

The go-exploit API docs are critical — the model was trained before this
framework existed, so without them it hallucinates function signatures.

## Global Configuration

Config at `~/.config/cortex/cortex.jsonc` applies from any working
directory. Project-level `cortex.jsonc` overrides if present.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/devstral-16k:latest",
  "embedding": {
    "sources": ["/home/ebrown/work/"]
  },
  "instructions": ["~/.config/cortex/instructions.md"]
}
```

Instructions file (`~/.config/cortex/instructions.md`) contains the security
researcher system prompt that tells the model all CVE/exploit work is authorized.

Config resolution order (low to high priority):
1. Remote `.well-known/cortex` (org defaults)
2. **Global config** — `~/.config/cortex/cortex.jsonc`
3. `CORTEX_CONFIG` env var
4. **Project config** — `cortex.jsonc` in cwd or parent dirs
5. `.cortex/` directory configs
6. Enterprise managed config (`/etc/cortex/`)

## Quick Install (New Machine)

```bash
bash scripts/install-cortex-workstation.sh --gpu
```

This single script handles everything:
- bun runtime
- ollama + model pulls (devstral-16k, nomic-embed-text)
- cortex repo clone + dependency install
- `~/.local/bin/cortex` launcher
- Global config + instructions
- Go stdlib/module/go-exploit API doc generation
- RAG manifest reset for first-launch indexing

Options:
```
--skip-ollama       Already have ollama installed
--skip-models       Models already pulled (or offline transfer)
--skip-docs         Skip Go doc generation (no go installed)
--skip-bun          Already have bun installed
--gpu               GPU mode (ollama auto-detects)
--work-dir DIR      RAG source directory (default: ~/work)
--model MODEL       Default LLM (default: devstral-16k:latest)
```

### Offline Model Transfer

If the target machine has no internet, pull models on a connected machine and
transfer the ollama model directory:

```bash
# On connected machine
ollama pull devstral-16k:latest
ollama pull nomic-embed-text

# Copy to USB / network share
tar czf ollama-models.tar.gz ~/.ollama/models/

# On target machine
tar xzf ollama-models.tar.gz -C ~/
```

## Usage

```bash
cd ~/work/cve-2025-XXXXX
cortex
```

Works from any directory. The global config provides the model, RAG sources,
and instructions. RAG auto-indexes on first launch (~13 min on CPU for 341
files / 4210 chunks, instant on subsequent launches for unchanged files).

## Token Budget (16K context)

| Component | Tokens |
|---|---|
| System prompt + tool schemas (5 compact tools) | ~1,800 |
| Main RAG (`<rag-context>`) | ~2,500 |
| Error RAG (`<error-context>`) — only on build errors | ~800 |
| Conversation history + tool results | ~8,000-10,000 |
| Model output | ~1,200 |

Error RAG is transient — it only appears when the previous step had a
compilation failure and clears after injection.

## Model Notes

| Model | Status |
|---|---|
| devstral-16k (24B) | Primary — good at agentic tool use, follows exploit templates |
| devstral-8k (24B) | Fallback — same model, smaller context window |
| qwen2.5-coder:7b | Tested — too small for reliable agentic use |
| qwen2.5-coder:3b | Tested — hallucinated tool calls, unusable |
| llama3.1:8b | Available — backup general-purpose model |

CPU inference on devstral-16k is slow (~19 min per complex response). GPU
target machine should bring this to seconds.

## Files

```
src/embedding/error-rag.ts          Error-aware RAG retrieval
src/embedding/metadata-extract.ts   Enhanced doc detection (.docs/, frontmatter)
src/embedding/rag.ts                RAG indexer (crawl, chunk, embed, store)
src/embedding/format.ts             RAG result formatter for LLM context
src/session/prompt.ts               Ollama prompt path + error RAG injection
scripts/build-go-docs.py            Go documentation dataset builder
scripts/install-cortex-workstation.sh  One-script installer
~/.config/cortex/cortex.jsonc       Global config
~/.config/cortex/instructions.md    Security researcher instructions
~/work/.docs/                       Generated documentation for RAG
```
