# Cortex API — Third-Party Integration Guide

How to connect websites, mobile apps, CLI tools, and other external clients
to the Cortex server.

---

## Quick Start

### 1. Start the Daemon

```bash
# Start as background service (persists after shell exits)
opencode serve start --hostname 0.0.0.0 --port 4096

# Or let the TUI auto-start it (localhost only, random port)
opencode
```

### 2. Create an API Token

```bash
# Via CLI
opencode token create --name "my-app" --scopes "*" --expiry 30d

# Save the token — it's only shown once
# Output: ctx_a1b2c3d4e5f6...
```

### 3. Make Your First Request

```bash
curl -H "Authorization: Bearer ctx_a1b2c3..." \
     http://localhost:4096/health
# → {"ok":true,"time":1711123200000}
```

---

## Authentication

All requests (except `GET /health` and CORS preflight) require authentication.

### Bearer Token (Recommended)

```
Authorization: Bearer ctx_XXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Tokens are created via CLI (`opencode token create`) or the REST API (`POST` to
the token MCP tool). They support scoping and optional expiry.

### Basic Auth (Alternative)

Set `CORTEX_SERVER_PASSWORD` before starting the server:

```bash
CORTEX_SERVER_PASSWORD=mysecret opencode serve start
```

Then authenticate with:
```
Authorization: Basic base64(opencode:mysecret)
```

Username defaults to `opencode`. Override with `CORTEX_SERVER_USERNAME`.

---

## CORS

The server accepts requests from:
- `http://localhost:*` and `http://127.0.0.1:*`
- `https://*.opencode.ai`
- Tauri origins: `tauri://localhost`, `http://tauri.localhost`
- Custom origins via server config

For web apps on other domains, configure CORS in server options or proxy
through your own backend.

---

## REST API Reference

### Health Check

```
GET /health
→ { "ok": true, "time": 1711123200000 }
```

No auth required. Use this to check if the daemon is alive.

### Sessions

**List sessions**:
```
GET /session/?limit=20&search=keyword
→ [{ id, title, directory, time: { created, updated } }, ...]
```

**Create session**:
```
POST /session/
Body: { "title": "My Task" }
→ { id, title, ... }
```

**Send a prompt (streaming)**:
```
POST /session/:sessionID/message
Body: { "parts": [{ "type": "text", "text": "Write a hello world" }] }
→ Streaming JSON response (newline-delimited events)
```

**Send a prompt (async — fire-and-forget)**:
```
POST /session/:sessionID/prompt_async
Body: { "parts": [{ "type": "text", "text": "Fix the bug" }] }
→ 204 No Content
```

Use async prompts when you don't need to stream the response in real-time.
Subscribe to SSE events to get notified when processing completes.

**Get messages**:
```
GET /session/:sessionID/message?limit=50
→ [{ id, role, parts: [...], time: { created } }, ...]
```

**Abort processing**:
```
POST /session/:sessionID/abort
→ 200
```

### Scheduled Tasks

**List tasks**:
```
GET /schedule (via MCP) or /schedule list (via CLI)
```

**Create a task** (via MCP tool `schedule_create`):
```json
{
  "name": "Daily code review",
  "cron": "0 9 * * 1-5",
  "prompt": "Review open PRs and summarize findings",
  "delivery": { "type": "webhook", "url": "https://hooks.example.com/review" }
}
```

**Trigger immediately**:
```
POST /mcp-server  (MCP: schedule_trigger with task ID)
```

### Event Streaming (SSE)

**Subscribe to real-time events**:
```
GET /event
Accept: text/event-stream
Authorization: Bearer ctx_...
```

Response is a Server-Sent Events stream:
```
id: 42
event: message
data: {"type":"session.updated","properties":{"sessionID":"abc123"},"seq":42}

id: 43
event: message
data: {"type":"schedule.executed","properties":{"id":"schd_xyz","status":"success"},"seq":43}

: heartbeat
```

**Reconnection**: Include `Last-Event-ID: 42` header to catch up on missed events.
The server replays up to 500 events.

**REST replay** (for non-SSE clients):
```
GET /event/replay?after=42&limit=100
→ { "events": [...], "latestSeq": 55 }
```

### Device Registration & Sync

**Register a device**:
```
POST /device
Body: {
  "name": "iPhone",
  "type": "phone",
  "pushUrl": "https://your-push-endpoint.com/notify",
  "pushEvents": ["session.*", "schedule.executed"]
}
→ { id: "dev_xxx", ... }
```

**Sync (pull events since last cursor)**:
```
POST /sync
Body: {
  "deviceID": "dev_xxx",
  "includeSessions": true,
  "limit": 200
}
→ {
    "events": [...],
    "latestSeq": 150,
    "pending": 0,
    "sessions": [{ id, title, directory, updated }],
    "serverTime": 1711123200000
  }
```

**Sync protocol**:
1. Register device once → get `deviceID`
2. Poll `POST /sync` periodically (or when push notification arrives)
3. Server tracks your cursor (`lastSeenSeq`) automatically
4. Push notifications tell you *when* to sync — they don't carry event data

### API Tokens

**Create token**:
```
POST /mcp-server  (MCP: token_create)
Body: { "name": "mobile-app", "scopes": ["read", "write"], "expiresInHours": 720 }
→ { "token": "ctx_...", "info": { "id": "tok_xxx", "name": "mobile-app", ... } }
```

**List tokens** (never returns full token, only prefix):
```
POST /mcp-server  (MCP: token_list)
→ [{ "id": "tok_xxx", "name": "mobile-app", "prefix": "ctx_a1b2", "scopes": ["read","write"] }]
```

**Revoke**:
```
POST /mcp-server  (MCP: token_revoke)
Body: { "id": "tok_xxx" }
```

---

## MCP Protocol Integration

The Cortex server exposes a full MCP (Model Context Protocol) endpoint at
`/mcp-server`. Any MCP-compatible client can connect.

### Endpoint

```
POST /mcp-server   — MCP requests (JSON-RPC)
GET  /mcp-server    — MCP SSE stream
```

Response headers expose `mcp-session-id` and `mcp-protocol-version`.

### Available MCP Tools

| Tool | Description |
|---|---|
| `schedule_list` | List all scheduled tasks |
| `schedule_create` | Create a task (name, cron, prompt, delivery) |
| `schedule_update` | Update task properties |
| `schedule_delete` | Delete a task |
| `schedule_trigger` | Execute a task immediately |
| `session_list` | List recent sessions |
| `session_create` | Create session, optionally send initial prompt |
| `session_prompt` | Send prompt to session, get assistant response |
| `session_messages` | Get messages from a session |
| `token_list` | List API tokens (safe — no full tokens) |
| `token_create` | Create a new API token |
| `token_revoke` | Revoke a token by ID |
| `device_register` | Register a device for sync |
| `device_list` | List registered devices |
| `device_remove` | Remove a device |
| `device_sync` | Pull events + session list for a device |

### MCP Client Example (Python)

```python
import httpx

MCP_URL = "http://localhost:4096/mcp-server"
TOKEN = "ctx_your_token_here"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

def mcp_call(method: str, params: dict | None = None) -> dict:
    """Send a JSON-RPC request to the MCP server."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or {},
    }
    resp = httpx.post(MCP_URL, json=payload, headers=HEADERS)
    resp.raise_for_status()
    return resp.json()

# Initialize MCP session
init = mcp_call("initialize", {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {"name": "my-app", "version": "1.0.0"},
})
session_id = init.get("result", {}).get("sessionId")
if session_id:
    HEADERS["mcp-session-id"] = session_id

# List tools
tools = mcp_call("tools/list")
print(tools["result"]["tools"])

# Call a tool
result = mcp_call("tools/call", {
    "name": "schedule_list",
    "arguments": {},
})
print(result["result"])
```

### MCP Client Example (TypeScript)

```typescript
const MCP_URL = "http://localhost:4096/mcp-server"
const TOKEN = "ctx_your_token_here"

async function mcpCall(method: string, params?: Record<string, unknown>) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params ?? {},
    }),
  })
  return res.json()
}

// Initialize
const init = await mcpCall("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "my-app", version: "1.0.0" },
})

// Create a scheduled task
await mcpCall("tools/call", {
  name: "schedule_create",
  arguments: {
    name: "Nightly backup check",
    cron: "0 2 * * *",
    prompt: "Check backup status and report any failures",
    delivery_type: "webhook",
    delivery_url: "https://hooks.example.com/backup-status",
  },
})
```

---

## Integration Patterns

### Web Dashboard

```
┌──────────────┐     REST API      ┌──────────────┐
│  Web App     │ ──────────────→   │  Cortex      │
│  (React/Vue) │ ← SSE /event ──  │  Daemon      │
└──────────────┘                   └──────────────┘
```

1. Create an API token with `read` + `write` scopes
2. Use `GET /session/` to list sessions, `GET /session/:id/message` for history
3. Subscribe to `GET /event` SSE for live updates
4. Send prompts via `POST /session/:id/message` (streaming) or `prompt_async`

### Mobile App

```
┌──────────────┐     Push notify   ┌──────────────┐
│  Mobile App  │ ← ─ ─ ─ ─ ─ ─ ─  │  Cortex      │
│              │ ── POST /sync ──→ │  Daemon      │
└──────────────┘                   └──────────────┘
```

1. Register device: `POST /device` with push URL and event filters
2. When push notification arrives, call `POST /sync` to pull events
3. Display session updates, schedule results, etc.
4. Non-SSE friendly — pure request/response polling

### CI/CD Pipeline

```bash
# Trigger a scheduled review and wait for result
TASK_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  -X POST http://cortex:4096/mcp-server \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"schedule_trigger","arguments":{"id":"schd_abc"}}}' \
  | jq -r '.result.content[0].text' | jq -r '.sessionID')

# Poll for completion
while true; do
  STATUS=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "http://cortex:4096/session/$TASK_ID" | jq -r '.status')
  [ "$STATUS" = "completed" ] && break
  sleep 5
done
```

### Another AI Agent (MCP Client)

Any MCP-compatible AI agent can connect to Cortex as a tool server:

```json
{
  "mcpServers": {
    "cortex": {
      "url": "http://localhost:4096/mcp-server",
      "headers": {
        "Authorization": "Bearer ctx_your_token"
      }
    }
  }
}
```

This gives the external agent access to all 12 MCP tools — it can create
sessions, manage schedules, query session history, etc.

---

## Event Types

Events published to the journal and SSE stream:

| Event | Properties |
|---|---|
| `session.created` | `{ sessionID }` |
| `session.updated` | `{ sessionID }` |
| `session.deleted` | `{ sessionID }` |
| `message.created` | `{ sessionID, messageID }` |
| `message.updated` | `{ sessionID, messageID }` |
| `part.created` | `{ sessionID, messageID, partID }` |
| `part.updated` | `{ sessionID, messageID, partID }` |
| `schedule.created` | `{ info }` |
| `schedule.updated` | `{ info }` |
| `schedule.deleted` | `{ id }` |
| `schedule.executed` | `{ id, sessionID, status }` |
| `device.registered` | `{ info }` |
| `device.removed` | `{ id }` |

---

## Network Configuration

### Localhost Only (Default)

```bash
opencode serve start
# Binds to 127.0.0.1, random port
# Only accessible from the same machine
```

### LAN Access

```bash
opencode serve start --hostname 0.0.0.0 --port 4096
# Accessible from any device on the network
# ALWAYS set CORTEX_SERVER_PASSWORD or use API tokens
```

### mDNS Discovery

```bash
opencode serve start --hostname 0.0.0.0 --mdns
# Publishes via mDNS — clients can discover via Bonjour/Avahi
```

### Security Checklist

- [ ] Set `CORTEX_SERVER_PASSWORD` for basic auth, or create API tokens
- [ ] Use scoped tokens (`read`, `write`, `schedule`) — avoid `*` for production
- [ ] Set token expiry for temporary access
- [ ] Bind to `0.0.0.0` only when LAN access is needed
- [ ] Use a reverse proxy (nginx, Caddy) for TLS when exposing beyond LAN
- [ ] Monitor `daemon.log` in `~/.local/share/opencode/log/`

---

## Troubleshooting

**Daemon won't start**:
```bash
opencode serve status          # Check if already running
cat ~/.local/share/opencode/log/daemon.log  # Check logs
rm ~/.local/state/cortex/daemon.json        # Clear stale state
opencode serve start           # Try again
```

**Can't connect**:
```bash
curl http://127.0.0.1:PORT/health   # Check health (no auth needed)
```

**Token rejected**:
- Tokens are `ctx_` prefixed — include the full token
- Check expiry: expired tokens return 401
- Check scopes: operations outside token scope are rejected

**SSE disconnects**:
- Include `Last-Event-ID` header on reconnect to catch up
- The server replays up to 500 events
- 10s heartbeat keeps the connection alive through proxies
