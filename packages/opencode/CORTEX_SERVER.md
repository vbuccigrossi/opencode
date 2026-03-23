# Cortex Server — Architecture & Implementation

**Focus**: Background server providing scheduled tasks, cross-device session access,
event streaming, and MCP protocol support for external clients.

## Overview

The Cortex server runs as a background daemon (`opencode serve`) that persists
independently of TUI sessions. It provides:

- **Task Scheduler** — Cron-based scheduled prompts with configurable delivery
- **Event Journal** — Sequence-numbered event log with SSE streaming
- **API Token Auth** — SHA-256 hashed bearer tokens for headless/cross-device access
- **Device Sync** — Pull-based sync protocol with push notification triggers
- **MCP Server** — Model Context Protocol endpoint for external tool clients
- **Full REST API** — Session management, file operations, permissions, config

---

## Phase 1: Scheduling + MCP Server

### Schedule Module (`src/schedule/`)

| File | Purpose |
|---|---|
| `index.ts` | Schedule CRUD, cron validation, bus events |
| `scheduler.ts` | 30s poll daemon, 10-min execution timeout, overlap prevention |
| `delivery.ts` | Result delivery: session (default), file (markdown), webhook (2x retry) |
| `schedule.sql.ts` | SQLite schema + queries |

**Schedule Info**:
```typescript
{
  id: string,              // schd_XXXXXXXX (Identifier.descending("schedule"))
  projectID: string,
  name: string,
  cron: string,            // Standard 5-field cron expression
  prompt: string,          // LLM prompt to execute
  directory: string,       // Working directory for execution
  agent?: string,          // Optional agent override
  model?: string,          // Optional model override
  delivery: DeliveryConfig,
  enabled: boolean,
  lastRunAt?: number,
  lastStatus?: "success" | "error",
  lastError?: string,
  lastSessionID?: string,
  nextRunAt?: number,
  time: { created: number, updated: number }
}
```

**Delivery Types**:
- `{ type: "session" }` — Creates a session with the result (default)
- `{ type: "file", path: string }` — Writes markdown to a file
- `{ type: "webhook", url: string, headers?: Record<string, string> }` — POST with 2x retry

**Bus Events**: `schedule.created`, `schedule.updated`, `schedule.deleted`, `schedule.executed`

### MCP Server (`src/server/mcp-server.ts`)

12 tools across 4 categories, exposed via `/mcp-server` endpoint using
`WebStandardStreamableHTTPServerTransport` (POST for requests, GET for SSE streaming).

| Category | Tools |
|---|---|
| Schedule | `schedule_list`, `schedule_create`, `schedule_update`, `schedule_delete`, `schedule_trigger` |
| Session | `session_list`, `session_create`, `session_prompt`, `session_messages` |
| Token | `token_list`, `token_create`, `token_revoke` |
| Device | `device_register`, `device_list`, `device_remove`, `device_sync` |

### CLI Commands

```
opencode serve              # Foreground server (writes daemon state, starts scheduler)
opencode serve start        # Start as background daemon
opencode serve stop         # Stop background daemon (SIGTERM → SIGKILL after 5s)
opencode serve status       # Show daemon PID, URL, uptime
opencode schedule list      # List scheduled tasks
opencode schedule add       # Create scheduled task
opencode schedule remove    # Remove scheduled task
opencode schedule enable    # Enable a task
opencode schedule disable   # Disable a task
```

### Migration

`migration/20260322000000_add_scheduled_task/` — Creates `scheduled_task` table.

---

## Phase 2: Cross-Device Session Access

### API Tokens (`src/auth/token.ts`, `token.sql.ts`)

- Tokens use `ctx_` prefix + 48 random hex chars
- Stored as SHA-256 hashes in SQLite `api_token` table
- Scopes: `["*"]` (full), `"read"`, `"write"`, `"schedule"`
- Optional expiry timestamp

**CLI**: `opencode token create|list|revoke`

### Authentication (Dual-Layer)

1. **Bearer Token** — `Authorization: Bearer ctx_XXXXX` → `ApiToken.validate(token)`
2. **Basic Auth** — If `CORTEX_SERVER_PASSWORD` env var is set

Auth is checked on all routes except `GET /health` and CORS preflight (OPTIONS).

### Event Journal (`src/bus/journal.ts`, `journal.sql.ts`)

- Append-only SQLite log with auto-incrementing sequence numbers
- `BusEvent.subscribeAll()` feeds events into journal
- Auto-prune: max 10,000 events, pruned at 500-insert intervals
- Excludes: `server.heartbeat`, `server.connected`

**SSE Endpoint**: `GET /event`
- Real-time Server-Sent Events stream
- `Last-Event-ID` header for reconnection catch-up (up to 500 events)
- 10-second keepalive heartbeat

**REST Replay**: `GET /event/replay`
- `?after=<seq>` — Events after sequence number
- `?since=<timestamp>` — Events since timestamp (ms)
- `?limit=<n>` — Max events (default 200, max 500)

### Device Sync (`src/server/routes/sync.ts`)

Pull-based protocol — devices poll `/sync` with their cursor, get back delta events.

**Sync Flow**:
1. Device registers via `POST /device` (name, type, push URL, event filters)
2. Device polls `POST /sync` with `{ deviceID, afterSeq?, includeSessions?, limit? }`
3. Server returns events since cursor + optional session list
4. Push notifications (webhooks) tell devices *when* to sync — they don't carry data

### Migration

`migration/20260322100000_add_api_token_and_event_journal/` — Creates `api_token`,
`event_journal`, and `device` tables.

---

## Phase 3: Agent Integration + Daemon

### Native Agent Tools

| Tool | File | Operations |
|---|---|---|
| `schedule` | `src/tool/schedule.ts` | list, create, update, delete, trigger, get |
| `device` | `src/tool/device.ts` | list, register, update, remove, get, sync |
| `token` | `src/tool/token.ts` | list, create, revoke |

These call modules directly (in-process), no HTTP hop needed.

### Slash Commands

| Command | File | Subcommands |
|---|---|---|
| `/schedule` | `src/command/execute.ts` | list, create, delete, trigger, enable, disable, get, help |
| `/device` | `src/command/execute.ts` | list, register, remove, sync, get, help |
| `/token` | `src/command/execute.ts` | list, create, revoke, help |

Slash commands execute directly without sending to the LLM. They create synthetic
assistant messages via `commandDirect()` in `src/session/prompt.ts`.

### Daemon (`src/daemon/index.ts`)

**State File**: `~/.local/state/cortex/daemon.json`
```json
{
  "pid": 12345,
  "port": 4096,
  "hostname": "127.0.0.1",
  "startedAt": 1711123200000,
  "bin": "/usr/bin/opencode"
}
```

**Lifecycle**:
- `Daemon.start()` — Checks if already running first (idempotent). Spawns detached
  `opencode serve` with `CORTEX_DAEMON=1`. Polls for daemon.json + `/health` up to 15s.
- `Daemon.stop()` — SIGTERM, waits 5s, SIGKILL if needed
- `Daemon.status()` — Checks PID file + `/health` endpoint

**TUI Integration**: `Daemon.start()` is called fire-and-forget on TUI launch
(`src/cli/cmd/tui/thread.ts`). Only spawns if no daemon is already running.

**Serve Command**: `src/cli/cmd/serve.ts` — Writes daemon state on startup, cleans
up on SIGHUP/SIGTERM/exit. Starts the scheduler loop.

---

## Test Coverage

| Test File | Count | Scope |
|---|---|---|
| `test/schedule/schedule.test.ts` | 21 | Schedule CRUD, cron, delivery |
| `test/auth/token.test.ts` | 10 | Token create/validate/revoke/scope |
| `test/bus/journal.test.ts` | 7 | Event journal append/replay/prune |
| `test/tool/schedule-tool.test.ts` | 8 | Schedule agent tool |
| `test/tool/device-tool.test.ts` | 7 | Device agent tool |
| `test/tool/token-tool.test.ts` | 7 | Token agent tool |
| `test/command/execute.test.ts` | 17 | Slash command execution |
| `test/daemon/daemon.test.ts` | 7 | Daemon state management |

**Total**: 84 tests
