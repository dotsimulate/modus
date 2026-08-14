---
title: MO SDK Guide
audience: dev
covers: harness/sdk/*.ts harness/file-mutation-errors.ts
---

# MO SDK Guide

The MO SDK (`harness/sdk/`) is a TypeScript client for the MO harness API. It wraps
every HTTP endpoint into typed methods on a single `ModusClient` class. The same client
is used by the React frontend, the CLI (`modus` command), agent moves, and external
scripts.

For method-level API reference, generate the TypeDoc output with
`bun run docs:sdk` from `harness/`.

---

## Quick Start

```typescript
import { ModusClient } from "./harness/sdk";

const client = new ModusClient({
  // Source/CLI mode defaults to this port. The managed desktop chooses a
  // per-launch loopback port and supplies its own target.
  url: "http://localhost:3777",
  pin: "1234",             // or token: "bearer-token-here"
});

// One-shot: send a prompt and get the text response
const { sessionId, text } = await client.prompt({
  prompt: "What files changed today?",
  profile: "dev",
});
console.log(text);
```

Three lines: construct, prompt, read. The `prompt()` convenience method handles session
creation, SSE streaming, and text extraction internally.

### Finding the managed desktop backend

The desktop does not listen on port 3777. It starts the harness with
`HARNESS_PORT=0`, so the OS assigns a new loopback port on each launch. An
external client should resolve its base URL at call time:

1. Use an explicitly configured URL (the bundled CLI names this override
   `MODUS_URL`).
2. For a locally managed desktop, read
   `<MODUS_HOME>/runtime/desktop-supervisor.json` and use its `apiBase` (or
   construct the same loopback URL from `port`). With `MODUS_INSTANCE=<name>`,
   the record is under `<MODUS_HOME>/<name>/runtime/`.
3. Use `http://localhost:3777` only for a source/CLI harness that was started on
   the default fixed port.

Re-read the supervisor file rather than caching it. The desktop writes it by
temporary-file rename and deletes it on shutdown; absence means no managed
desktop backend is currently published. `apiBase` is loopback-only and the
record does not grant authentication. A remote client still needs the selected
backend's reachable HTTPS/Tailscale origin and normal PIN/browser-token flow.
The supervisor file is an internal discovery record, so external clients should
depend only on `apiBase`/`port`, not its other fields.

---

## Authentication

Modus browser PIN protection is optional. `authStatus()` reports whether a PIN is enabled,
whether first-run setup is needed, and whether the backend currently requires a token.
When a PIN is enabled, verifying it returns a browser session token. A
PIN-authenticated browser is an operator-level, full-machine principal rather than a
project-root sandbox, so SDK/browser callers must protect that token accordingly.

```typescript
// Discover first-run, PIN, and token requirements.
const { required, setup, tokenRequired } = await client.authStatus();

if (setup) {
  // First run: this example chooses to enable a PIN.
  const token = await client.setupNewPin("1234", "my-machine");
  client.setToken(token);
} else if (required) {
  // Verify existing PIN
  const token = await client.verifyPin("1234");
  client.setToken(token);
} else if (tokenRequired) {
  // No PIN: obtain a distinct browser session token without putting it in the URL.
  const token = await client.createBrowserSession();
  if (token) client.setToken(token);
}
```

**Automatic PIN auth:** If you pass `pin` in the constructor options, the client
auto-authenticates on the first API call when PIN protection is enabled. You don't need
to call `verifyPin` manually.

**Browser usage:** Pass a `getToken` callback instead of a static token. The current
frontend reads its browser-session token from `localStorage`:

```typescript
const client = new ModusClient({
  url: "",  // same origin
  getToken: () => localStorage.getItem("harness_token") || undefined,
});
```

---

## Session Lifecycle

Sessions are the core unit of work. A session wraps a single agent conversation with
a full event log.

### History hydration and paging

The frontend's canonical path is `ensureSubscribed`: it resolves persisted
history before opening/resuming SSE so snapshot rows are not replayed as live
duplicates. A cold or settled session requests the newest 12 messages from
`GET /api/sessions/:id/history-snapshot`; a retained settled transcript paints
synchronously but is revalidated before SSE resumes. Cold active sessions also
fetch a snapshot, then subscribe from the newest materialized message so any
in-flight events after that boundary replay live.

The snapshot endpoint accepts:

- `limit=1..100` (default 40), or `limit=all`
- `beforeCreatedAt=<epoch-ms>` — preferred paging boundary
- `beforeSeq=<positive integer>` — compatibility fallback when no wall-clock
  cursor is supplied
- `details=full|summary` — summary mode defers large thinking/tool payloads

Responses carry `hasMoreHistory`, `oldestCreatedAt`, `oldestSeq`, and
`olderTurnCount`. Older pages send both available cursors, prepend de-duplicated
messages without changing the live SSE cursor, and use the returned
`olderTurnCount` to keep turn numbering stable. Wall-clock order is authoritative
because a resumed provider may reuse sequence numbers. A deferred turn is
expanded separately through the single-message content endpoint.

Switching away unsubscribes settled sessions but retains the eight most recently
used transcripts, including any older pages the user explicitly loaded. Older
settled entries are evicted whole. Running, starting, interrupting, and paused
sessions are not eligible for that settled cache eviction.

### Create and interact

```typescript
// High-level: interact() creates or continues a session
const result = await client.interact({
  prompt: "Refactor the auth module",
  profile: "dev",
  cwd: "/home/user/my-project",
});
// result.sessionId — the session ID
// result.status — "running", "idle", etc.

// Continue an existing session
await client.sendMessage(result.sessionId, "Also update the tests");
```

### Image attachments (SDK and raw REST)

Both `POST /api/sessions/interact` and `POST /api/sessions/:id/messages` accept
the same `attachments` array. Each entry is a base64 image with this exact wire
shape:

```typescript
type ApiAttachment = {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string; // standard padded base64 only; no data:image/...;base64, prefix
  name?: string;
};
```

The request validator rejects other MIME types, empty or malformed base64, and
data-URL prefixes. A text `prompt` is still required even when an image is
attached. In the SDK:

```typescript
await client.sendMessage(sessionId, {
  prompt: "Describe this image",
  attachments: [{
    type: "image",
    mediaType: "image/png",
    data: pngBytes.toString("base64"),
    name: "diagram.png",
  }],
});
```

Raw REST clients send the identical JSON. Set `subscribe: false` on `interact`
when a JSON response is wanted; its default response is an SSE stream.

```bash
curl -X POST "$MODUS_URL/api/sessions/interact" \
  -H "Authorization: Bearer $MODUS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "prompt": "Describe this image",
    "profile": "dev",
    "subscribe": false,
    "attachments": [{
      "type": "image",
      "mediaType": "image/png",
      "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "name": "pixel.png"
    }]
  }'

curl -X POST "$MODUS_URL/api/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $MODUS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "prompt": "Now compare this image",
    "attachments": [{
      "type": "image",
      "mediaType": "image/jpeg",
      "data": "/9j/4AAQSkZJRgABAQ==",
      "name": "comparison.jpg"
    }]
  }'
```

### Create without starting

```typescript
const sessionId = await client.createEmptySession({
  profile: "dev",
  cwd: "/home/user/my-project",
});
// Session exists but no agent is running yet
await client.sendMessage(sessionId, "Start working on the auth refactor");
```

### Session state

```typescript
const status = await client.getSessionStatus(sessionId);
// status.status — "idle" | "running" | "stopped" | "error"
// status.profile — current agent profile name
// status.model — current model

// List recent sessions
const sessions = await client.listSessions({ limit: 20 });

// Search session content (full-text, FTS5)
const hits = await client.searchSessions("auth refactor");
```

### Branching

Create a new session that forks from a specific point in the event stream:

```typescript
const branchId = await client.branchSession(sessionId, 42);
// branchId is a new session with events 1-42 copied from the original
```

### Lifecycle management

```typescript
await client.stopSession(sessionId);         // Stop a running session
await client.archiveSession(sessionId);      // Soft-delete
await client.unarchiveSession(sessionId);    // Restore
await client.updateTitle(sessionId, "Auth refactor v2");
```

---

## Streaming (SSE)

MO uses Server-Sent Events for real-time session updates. Two patterns:

### Async iterator (for scripts)

```typescript
const handle = await client.interact({
  prompt: "Analyze this codebase",
  profile: "dev",
  subscribe: true,
});

for await (const event of handle.events) {
  // event.event — "stream_event", "status", "result", "error", etc.
  // event.data — parsed JSON payload
  // event.seq — sequence number
  console.log(event.event, event.data);
}
// Stream ends when the session completes
```

### Callback-based (for UI)

```typescript
const unsubscribe = client.subscribeEvents(sessionId, lastSeq, {
  onEvent: (event, seq) => {
    // Process each event — feed to a reducer, update UI, etc.
  },
  onDone: () => {
    // Session finished cleanly
  },
  onDisconnect: () => {
    // Connection lost — reconnect from lastSeq
  },
  onError: (msg) => {
    // Non-recoverable error
  },
});

// Later: stop listening
unsubscribe();
```

### Global event stream

Subscribe to events across all sessions (useful for dashboards):

```typescript
const { events, abort } = client.subscribeGlobalEvents();
for await (const event of events) {
  // Covers all active sessions
}
```

### Convenience: collect all events

```typescript
const { sessionId, events } = await client.run({
  prompt: "Quick task",
  profile: "dev",
});
// events is SSEEvent[] — the full event stream, collected after completion
```

---

## Profiles

MO has two profile types: **agent profiles** (how an agent behaves) and **user profiles**
(who is using the system).

### Agent profiles

```typescript
// List available profiles (optionally scoped to a project)
const profiles = await client.listProfiles("/home/user/my-project");

// Get a specific profile
const dev = await client.getProfile("dev");
// dev.prompt, dev.model, dev.provider, dev.skills, dev.permissionPolicy, ...

// Save or update a profile
await client.saveProfile("dev", {
  ...dev,
  model: "claude-sonnet-4-6",
});
```

### User profiles

User profiles scope visibility, memory, and template variables:

```typescript
const users = await client.listUserProfiles();
const me = await client.getUserProfile("alex");
// me.visibleAgents — which agents this user sees
// me.templateVars — Handlebars vars injected into agent prompts

// Runtime state (selected session, UI preferences)
const state = await client.getUserProfileState("alex");
await client.patchUserProfileState("alex", { selectedSessionId: "abc" });
```

### Mid-session profile switch

```typescript
await client.switchProfile(sessionId, "researcher");
// The session now uses the "researcher" agent profile
```

---

## Moves

Moves are structured operations — games, tools, workflows — that integrate with agent
sessions. They can have widgets (HTML), API tokens, and multiple execution modes.

```typescript
// List moves available in a project
const moves = await client.listMoves("/home/user/my-project");

// Activate a move on a session
const result = await client.activateMove(sessionId, {
  moveName: "handoff",
  inputs: { style: "briefing", targetProfile: "dev" },
  cwd: "/home/user/my-project",
});
// result.token — API token for move ops (10-minute TTL)
// result.moveRunId — tracks this activation

// Inline activation gathers but does not send. Dispatch the returned prompt
// as a second, explicit step (optionally merged with the user's own text).
if (result.requiresDispatch) {
  await client.sendMessage(sessionId, {
    prompt: [result.prompt, "Use concise output"].filter(Boolean).join("\n\n"),
  });
}

// Project-level activation has no parent session. An inline result still needs
// a target; choose branch/background when it should run immediately.
const result2 = await client.activateProjectMove({
  moveName: "chess",
  inputs: {},
  cwd: "/home/user/my-project",
  modeOverride: "branch",
});

// launchMove() returns the complete ActivateMoveResult; it does not drop the
// prompt, widget, API-token, or dispatch fields.
const launched = await client.launchMove("chess", "/home/user/my-project", {
  modeOverride: "branch",
});

// Call a named operation on an active move
await client.callMoveOp("chess", result2.token, "make-move", { move: "e2e4" });

// Ambient moves inject context into every turn
const ambient = await client.listAmbientMoves(sessionId);
await client.deactivateAmbient(sessionId, "memory");
```

---

## Actions

Actions are automated agent workflows — scheduled, webhook-triggered, or chained.

```typescript
// List configured actions
const actions = await client.listActions();

// Manually trigger an action
await client.triggerAction("daily-standup");

// View execution history
const runs = await client.getActionRuns("daily-standup", 10);

// Reload all action configs from disk
await client.reloadActions();
```

---

## Missions

Missions are multi-step agent workflows with transfers, gates, and session orchestration.

```typescript
const { runId } = await client.startMission({
  missionName: "release-prep",
  cwd: "/home/user/my-project",
});

// Monitor progress
const run = await client.getMissionRun(runId);
const steps = await client.getMissionSteps(runId);
const transfers = await client.getMissionTransfers(runId);
const gates = await client.getMissionGates(runId);
const sessions = await client.getMissionSessions(runId);

// Pause/resume
await client.pauseMission(runId, "waiting for review");
await client.resumeMission(runId);
```

---

## Providers

Providers are execution backends (Claude Code, Codex, Cursor, Grok Build, PI agent variants).

```typescript
const providers = await client.listProviders();
// ["claude-code", "claude-code-pty", "codex", "cursor", "grok-build", "opencode", ...]
// Hidden providers (antigravity, gemini-cli) are usable by name but never listed.

const caps = await client.getProviderCapabilities();
// Each: { name, streaming, tools, vision, builtInToolMode, ... }

const health = await client.getProviderHealth();
// Each: { name, healthy, checks: [...] }

const models = await client.getProviderModels("openrouter");
// Each: { id, label, contextWindow, ... }
```

---

## Git Operations

```typescript
const status = await client.gitStatus("/home/user/my-project");
// status.branch, status.clean, status.staged, status.unstaged, ...

const log = await client.gitLog("/home/user/my-project", 20);
// Array of { hash, message, author, date, ... }

const detail = await client.gitShow("abc1234", "/home/user/my-project");
// Full commit: message, diffs, files changed

// Open a file in the user's editor (server-side)
await client.openInEditor("/home/user/my-project/src/auth.ts", 42);
```

---

## File Operations

The SDK provides server-side file operations (these run on the harness host):

```typescript
const content = await client.readFile("/home/user/project/README.md");

const listing = await client.browse("/home/user/project", {
  includeHidden: false,
  includeFiles: true,
});
```

### Mutations return a status, not a boolean

`writeFile`, `createFile`, and `createDirectory` return a `FileMutationResult`.
**Inspect `.ok`** — the object is truthy on failure too, so treating the return
value itself as a boolean silently succeeds forever:

```typescript
const created = await client.createDirectory("/home/user/project/new-dir");
if (!created.ok) {
  if (created.code === "collision") { /* the name is taken */ }
  else if (created.code === "denied") { /* fix permissions */ }
  else if (created.code === "read-only") { /* choose another volume */ }
  console.error(created.error);   // written for a person to read
}
```

`code` is a `FileMutationErrorCode`:

| `code` | Meaning | Status |
|---|---|---|
| `collision` | the path already exists; `createFile`/`createDirectory` never overwrite | 409 |
| `denied` | the OS refused — `EACCES`/`EPERM` | 403 |
| `read-only` | the filesystem is mounted read-only — `EROFS` | 403 |
| `missing-parent` | a parent directory does not exist — `ENOENT` | 404 |
| `not-a-directory` | a path component exists but is not a directory — `ENOTDIR` | 409 |
| `no-space` | the volume is full — `ENOSPC` | 507 |
| `rejected` | the request was malformed (no path, no content) | 400 |
| `unauthorized` | the file API auth gate refused the caller | 401/403 |
| `failed` | anything else; `error` still carries the underlying message | 500 |

Classification reads the OS `errno`, never the message text — messages are
localized and differ between Windows and POSIX. On success, `path` is the
absolute path the server resolved, which is not necessarily the string that was
passed in.

---

## Analytics and Activity

```typescript
// Session stats
const stats = await client.getSessionStats();

// Provider usage over time
const usage = await client.getProviderUsageAnalytics("alex", 30);

// Deep analytics with time bucketing
const deep = await client.getDeepAnalytics({
  start: Date.now() - 7 * 86400000,
  end: Date.now(),
  bucketMs: 3600000, // hourly buckets
});

// Activity log (audit trail)
const activity = await client.getActivity({ limit: 50 });
const summary = await client.getActivitySummary({ hours: 24 });
```

`getDeepAnalytics({ start, end, bucketMs?, userProfile?, cwd?, provider? })`
backs `GET /api/analytics/deep`. The default range is the previous 48 hours and
the default bucket is one hour. Bucket widths snap to the nearest supported
value (5, 15, or 30 minutes; 1, 2, 6, 12, or 24 hours) and the response is capped
at 512 buckets. `cwd` is a path-prefix filter; `userProfile` includes matching
sessions plus legacy rows with no user profile; `provider` matches the stored
provider exactly. Sessions tagged `archived` or `internal` are excluded.

The response includes `range`, aggregate `totals`, time `buckets`, breakdowns
`byProvider`/`byModel`/`byProfile`/`byProject`, local-hour distribution
`byHour`, per-session rows, and file-touch `trace` data (`summary` and
`topFiles`). Token/cost/duration values come from durable result events; file
touches come from the trace store and are folded into the same time buckets.

---

## Terminals

The SDK can create and manage terminal sessions on the harness host:

```typescript
const terminal = await client.createTerminal({ cwd: "/home/user/project" });
const ws = client.connectTerminalWS(terminal.id);

// WebSocket is binary (arraybuffer) — send/receive terminal I/O
ws.onmessage = (e) => { /* render terminal output */ };
ws.send(new TextEncoder().encode("ls\n"));

await client.resizeTerminal(terminal.id, 120, 40);
await client.deleteTerminal(terminal.id);
```

---

## Error Handling

Non-OK HTTP responses throw `ModusError` (for methods using `fetchOrThrow`) or
return fallback values (empty arrays, null) for methods using the permissive `fetch`.

```typescript
import { ModusError } from "./harness/sdk";

try {
  await client.getProfile("nonexistent");
} catch (e) {
  if (e instanceof ModusError) {
    console.log(e.status);  // 404
    console.log(e.detail);  // "Profile not found"
    console.log(e.path);    // "/api/profiles/nonexistent"
  }
}
```

Methods that return fallback values (not throwing):
- `getProviderModels()` → `[]` on error
- `readFile()` → `null` on error
- `gitFileContent()` → `null` on error
- `listMoves()`, `listAmbientMoves()`, `getActiveWidgets()` → `[]` on error

---

## CLI Quick Reference

The `modus` CLI (`harness/sdk/cli.ts`) wraps the SDK for terminal usage:

```bash
# One-shot interaction
modus interact --profile dev "Refactor the auth module"

# Send to an existing session
modus send <session-id> "Also update tests"

# List sessions
modus sessions --limit 20
modus sessions --active
modus sessions --archived

# Session management
modus status <session-id>
modus messages <session-id>
modus stop <session-id>
modus branch <session-id> <seq>

# Search
modus search "auth refactor" --limit 10

# Profiles and providers
modus profiles
modus providers
modus provider openrouter models

# Tags
modus tag <session-id> add release-v2
modus tag <session-id> remove wip

# Moves and actions
modus moves --cwd /path/to/project
modus actions
modus trigger <action-name>
```

Environment variables:
- `MODUS_URL` — source/CLI harness URL (default: `http://localhost:3777`); managed desktop uses its per-launch target instead
- `MODUS_TOKEN` — bearer token (skips PIN auth)
- `MODUS_PIN` — PIN for auto-auth (also reads from `~/.config/agent-dev-zone/secrets.env`)
