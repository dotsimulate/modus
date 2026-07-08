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

---

## Authentication

MO uses PIN-based auth. First access requires setup; subsequent access verifies the PIN
and returns a bearer token.

```typescript
// Check if auth is required and if a PIN exists
const { required, setup } = await client.authStatus();

if (required && !setup) {
  // First time — set up a PIN
  const token = await client.setupNewPin("1234", "my-machine");
  client.setToken(token);
} else if (required) {
  // Verify existing PIN
  const token = await client.verifyPin("1234");
  client.setToken(token);
}
```

**Automatic PIN auth:** If you pass `pin` in the constructor options, the client
auto-authenticates on the first API call. You don't need to call `verifyPin` manually.

**Browser usage:** Pass a `getToken` callback instead of a static token. The frontend
uses this to read from `localStorage`:

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
const me = await client.getUserProfile("dot");
// me.visibleAgents — which agents this user sees
// me.templateVars — Handlebars vars injected into agent prompts

// Runtime state (selected session, UI preferences)
const state = await client.getUserProfileState("dot");
await client.patchUserProfileState("dot", { selectedSessionId: "abc" });
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

// Project-level activation (creates a new session)
const result2 = await client.activateProjectMove({
  moveName: "chess",
  inputs: {},
  cwd: "/home/user/my-project",
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

Providers are execution backends (Claude Code, Codex, Gemini CLI, PI agent variants).

```typescript
const providers = await client.listProviders();
// ["claude-code", "claude-code-pty", "codex", "cursor", "gemini-cli", "opencode", ...]

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
await client.writeFile("/home/user/project/config.json", JSON.stringify(cfg));
await client.createFile("/home/user/project/new-file.ts", "export {}");
await client.createDirectory("/home/user/project/new-dir");

const listing = await client.browse("/home/user/project", {
  includeHidden: false,
  includeFiles: true,
});
```

---

## Analytics and Activity

```typescript
// Session stats
const stats = await client.getSessionStats();

// Provider usage over time
const usage = await client.getProviderUsageAnalytics("dot", 30);

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
- `MODUS_URL` — harness URL (default: `http://localhost:3777`)
- `MODUS_TOKEN` — bearer token (skips PIN auth)
- `MODUS_PIN` — PIN for auto-auth (also reads from `~/.config/agent-dev-zone/secrets.env`)
