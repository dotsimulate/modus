---
name: create-move
description: >
  Create MO moves, the universal interaction primitive. Moves can combine prompt
  context, submit schemas, API ops, widgets, pages, persistence, multi-agent
  orchestration, and background or branch sessions. Use when someone wants to
  create a capability, game, tool, workflow, companion conversation, widget,
  agent-facing API contract, ambient/persistent context source, full app page,
  council-like orchestration, or structured conversation that saves results.
  Each move lives in .modus/moves/name/ with move.json and context.ts. Trigger on:
  "create a move", "new move", "build a move", "interactive move", "api
  contract", "agent tool", "persistent move", "widget", "full page",
  "multi-agent", "companion move", "check-in".
---

# Create Move

Moves are the user-facing invocation primitive — WHAT the user wants done right now.
A move is an activation context: gather state, build a prompt, give the agent a typed
contract, let the harness be the referee.

- **Profiles** define WHO the agent is
- **Actions** define WHEN automation runs
- **Moves** define WHAT happens

Each move is a directory:

```
.modus/moves/<name>/
  move.json     <- declaration
  context.ts    <- gather() + optional handlers/onSubmit/onAssistantTurn
  widget.tsx    <- optional UI component
  widget.css    <- optional widget styles (auto-loaded when present)
  state/        <- auto-created for persisted API state
```

Built-in moves: `harness/moves/`. Project-local: `.modus/moves/` (overrides built-ins
by name).

## Decision Tree

**"I need to inject context into the session"**
  Context injection — simplest possible move. See [Context Injection](#context-injection).

**"I need ambient context on every turn"**
  Persistent move. `persistent: true`. See [Persistent](#persistent).

**"I need a structured conversation that saves results"**
  Companion move — gather builds a prompt, agent has the conversation, writes files
  at the end. No submit, no API, no TTL. See [Companion](#companion).

**"I need the agent to produce a single structured artifact"**
  Submit move. `submit.required: true`, optional schema validation.
  See [Submit](#submit).

**"I need the agent to interact with something repeatedly"**
  API contract move. Named ops, persistent state, token auth.
  See [API Contract](#api-contract).

**"I need a visual interface"**
  Add a `widget` block to any of the above.
  See [references/widget-moves.md](references/widget-moves.md).

**"I need a full page in the app nav"**
  Add a `page` block.
  See [references/widget-moves.md](references/widget-moves.md) (page section).

**"I need multiple agents working together"**
  Multi-agent move. `harness.createSession` + `onAssistantTurn`.
  See [references/multi-agent-moves.md](references/multi-agent-moves.md).

**Not sure?** Start with the simplest pattern that fits. You can always add facets
later — a gather-only move can gain an API block, a widget, or persistence without
restructuring.

## Patterns

### Context Injection

The simplest move. gather() runs once, returns a string that's injected into the
session. No submission, no state, no widget.

**When:** One-time context injection — git status, project info, file contents.

```json
{
  "name": "recent-changes",
  "label": "Recent Changes",
  "description": "Inject recent git changes into the session",
  "icon": "git-commit",
  "submit": { "required": false },
  "session": { "afterSubmit": "continue" },
  "tags": ["context"]
}
```

```ts
import type { MoveContext } from "../../../harness/move-types";

export async function gather(ctx: MoveContext): Promise<string | null> {
  const data = await ctx.run("git diff HEAD~3..HEAD --stat");
  if (!data.trim()) return null; // nothing to inject — bail
  return `Recent changes:\n\`\`\`\n${data}\n\`\`\``;
}
```

**Key:** Return `null` to bail (nothing injected). Return a string to add it to the
prompt. That's it.

### Companion

A structured conversation that reads context, guides discussion, and saves results
to files. No submit token, no API, no widget — the conversation IS the interaction.

**When:** Check-ins, reflections, interviews, coaching, journaling — any move where
the value is a real conversation and the output is persisted knowledge.

```json
{
  "name": "check-in",
  "label": "Check In",
  "description": "Structured catch-up — what's in flight, what changed, what's stuck",
  "icon": "coffee",
  "tags": ["personal", "context"]
}
```

```ts
import type { MoveContext } from "../../../harness/move-types";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return fallback; }
}

export async function gather(ctx: MoveContext): Promise<string> {
  const memoryDir = join(ctx.cwd, "memory");
  let memoryContext = "";
  try {
    const files = readdirSync(memoryDir).filter(
      (f: string) => f.endsWith(".md") && f !== "project-status.md"
    );
    for (const file of files) {
      const content = readFileOr(join(memoryDir, file), "");
      if (content) memoryContext += `\n--- ${file} ---\n${content}\n`;
    }
  } catch { /* memory dir might not exist yet */ }

  const previousStatus = readFileOr(
    join(ctx.cwd, "memory/project-status.md"), ""
  );
  const today = ctx.date ?? new Date().toISOString().split("T")[0];

  let prompt = `# Check-In\n\nToday: ${today}\n\n`;
  prompt += `## Your Role\n\nThis is a conversational check-in — not a form. `;
  prompt += `Guide the conversation through what's in flight, what changed, `;
  prompt += `what's stuck, and what's next. Ask follow-ups. Notice what's unsaid.\n\n`;
  prompt += `**When the conversation winds down:** Save what you learned to `;
  prompt += `\`memory/project-status.md\` and append a summary to `;
  prompt += `\`memory/check-in-history.md\`.\n\n`;

  if (memoryContext) prompt += `## What You Know\n\n${memoryContext}\n\n`;
  if (previousStatus.trim()) {
    prompt += `## Last Status\n\n${previousStatus}\n\n`;
    prompt += `Reference naturally — "last time you mentioned X, how's that going?"\n`;
  } else {
    prompt += `## First Check-In\n\nStart broad — get the lay of the land.\n\n`;
  }

  return prompt;
}
```

**Key:** No `submit` field, no `api` field. gather() builds a conversational prompt
that tells the agent what to explore and where to save results. The agent writes
files directly — no tokens, no TTL, no expiry issues.
See [references/companion-moves.md](references/companion-moves.md).

### Persistent

Re-runs gather() on **every user message** while active. Ambient context injection —
the agent doesn't need to know it's happening.

**When:** Live status, open files, project rules, cost tracking, behavioral modifiers.

```json
{
  "name": "test-status",
  "label": "Test Status",
  "description": "Inject failing test status into every turn",
  "icon": "radio",
  "persistent": true,
  "tags": ["ambient"]
}
```

```ts
import type { MoveContext } from "../../../harness/move-types";

export async function gather(ctx: MoveContext): Promise<string | null> {
  const status = await ctx.run("bun test --reporter=summary 2>&1 | tail -5");
  if (status.includes("0 fail")) return null; // all passing — bail
  return `## Test Status\n\`\`\`\n${status}\n\`\`\``;
}
```

**Key:** Gather-bail (`return null`) is critical — persistent gathers run every turn.
Skip injection when nothing changed. Keep output short — every string costs tokens
on every turn. See [references/persistent-moves.md](references/persistent-moves.md).

### Submit

One-shot structured output. Agent does work, calls `modus_submit(token, data)` once,
`onSubmit()` fires server-side.

**When:** Code review, document draft, structured analysis — anything that produces
a single artifact with a typed shape.

```json
{
  "name": "review",
  "label": "Code Review",
  "description": "Structured code review with severity-tagged comments",
  "icon": "search",
  "schemaHint": "{ comments: Array<{ file: string, line: number, severity: 'critical'|'suggestion', comment: string }> }",
  "submit": { "required": true, "maxAttempts": 3 },
  "session": { "afterSubmit": "continue" },
  "tags": ["dev"]
}
```

```ts
import type { MoveContext } from "../../../harness/move-types";

export async function gather(ctx: MoveContext): Promise<string> {
  const diff = await ctx.run("git diff HEAD~1..HEAD");
  return [
    "Review these changes and submit structured comments.",
    "",
    `Token: \`${ctx.token}\``,
    `Schema: ${ctx.schema}`,
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

export async function onSubmit(
  ctx: MoveContext,
  data: Record<string, unknown>,
  _inputs: Record<string, unknown>
): Promise<{ success: boolean; message: string }> {
  const comments = data.comments as Array<{
    file: string; severity: string; comment: string;
  }>;
  // Process — write to file, create issues, notify, etc.
  return { success: true, message: `${comments.length} comments recorded` };
}
```

**Key:** Submit token has 10min TTL — submit moves should be fast, not conversational.
If your move needs a long conversation, use the [Companion](#companion) pattern instead.
`schemaHint` gives the agent a compact shape. `maxAttempts` caps retries on invalid
submissions. `onSubmit()` runs server-side with full filesystem/network access.

### API Contract

Repeated interaction via named ops. Agent gets a persistent API token and calls ops
indefinitely. State persists across sessions.

**When:** Games, multi-step workflows, external API integration, tools with ongoing
state — anything where the interaction evolves through repeated agent actions.

```json
{
  "name": "tracker",
  "label": "Task Tracker",
  "description": "Track tasks with add, complete, and list operations",
  "icon": "check-square",
  "api": {
    "tokenPrefix": "tracker",
    "ops": {
      "add": {
        "description": "Add a new task",
        "schema": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "priority": { "type": "string", "enum": ["low", "med", "high"] }
          },
          "required": ["title"]
        }
      },
      "complete": {
        "description": "Mark a task as done",
        "schema": {
          "type": "object",
          "properties": { "id": { "type": "number" } },
          "required": ["id"]
        }
      },
      "list": { "description": "List all tasks" }
    },
    "state": { "persist": true }
  },
  "submit": { "required": false },
  "session": { "afterSubmit": "continue" },
  "tags": ["tool"]
}
```

```ts
import type {
  MoveContext, MoveApiContext, MoveApiHandler
} from "../../../harness/move-types";

interface Task { id: number; title: string; priority: string; done: boolean }
interface TrackerState { tasks: Task[]; nextId: number }

const empty: TrackerState = { tasks: [], nextId: 1 };

export async function gather(ctx: MoveContext): Promise<string> {
  const state = await getState(ctx);
  const pending = state.tasks.filter(t => !t.done);
  return [
    "You have access to the Task Tracker.",
    "",
    `Token: \`${ctx.apiToken}\``,
    "",
    `Current tasks: ${pending.length} pending`,
    "",
    "Ops: `add` (title, priority), `complete` (id), `list`",
  ].join("\n");
}

// Helper — gather can't use ctx.state, so read from disk
async function getState(ctx: MoveContext): Promise<TrackerState> {
  try {
    const raw = await ctx.run(
      `cat .modus/moves/tracker/state/${ctx.instanceId}.json 2>/dev/null`
    );
    return JSON.parse(raw);
  } catch { return empty; }
}

export const handlers: Record<string, MoveApiHandler> = {
  add: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const state = await ctx.state.get<TrackerState>() ?? { ...empty };
    const task: Task = {
      id: state.nextId++,
      title: data.title as string,
      priority: (data.priority as string) ?? "med",
      done: false,
    };
    state.tasks.push(task);
    await ctx.state.set(state);
    return { ok: true, message: `Added #${task.id}: ${task.title}` };
  },

  complete: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const state = await ctx.state.get<TrackerState>();
    if (!state) return { ok: false, error: "No tasks" };
    const task = state.tasks.find(t => t.id === data.id);
    if (!task) return { ok: false, error: `Task #${data.id} not found` };
    task.done = true;
    await ctx.state.set(state);
    return { ok: true, message: `Completed #${task.id}: ${task.title}` };
  },

  list: async (ctx: MoveApiContext) => {
    const state = await ctx.state.get<TrackerState>() ?? empty;
    return { ok: true, tasks: state.tasks };
  },
};
```

**Key:** API tokens have no TTL (unlike submit tokens). `ctx.caller` is `"agent"` or
`"user"` — gate sensitive ops accordingly. `ctx.state` is only available in handlers,
not in gather(). See [references/api-contract-moves.md](references/api-contract-moves.md).

## Facets Compose

These patterns aren't exclusive — most real moves combine 2-4 facets:

| Composition | What it looks like |
|-------------|-------------------|
| API + widget | Widget shows state, agent drives via ops (games, tools) |
| API + widget + mountOnAttach | Widget opens first, user configures, then agent joins |
| API + widget + page | Same component in right panel AND as full nav page |
| Persistent + API | Ambient injection AND the agent can call ops |
| Submit + branch | Agent writes a brief, onSubmit spawns a specialist session |
| API + multi-agent + widget | Orchestration with live progress visible in widget |

See [references/composition-patterns.md](references/composition-patterns.md) for
complete examples of each composition.

## Execution Modes

| Mode | Behavior | Use case |
|------|----------|----------|
| `inline` (default) | Returns prompt to current session | Most moves |
| `branch` | Spawns a sibling session | Heavy work, different profile needed |
| `background` | Fire-and-forget with status tracking | Long-running tasks |

Set via `"mode": "branch"` in move.json. Branch and background moves use
`agentProfile` to specify which agent handles the spawned session.

## Design Heuristics

Lessons from production use and hundreds of agent-built moves:

1. **USEFUL over impressive.** Would someone use this move twice? If it's only
   interesting the first time, it's a demo, not a tool.
2. **File paths over data blobs.** Don't pass large content through ops. Have the
   agent write to a file and pass the path — simpler, more robust, better persistence.
3. **Simple ops schemas.** If an agent needs extensive instructions to call your op,
   the schema is too complex. Ops should be obvious from the description alone.
4. **The agent is not decoration.** If the agent adds nothing a widget alone couldn't
   do, you don't need a move — you need a widget. Moves shine when the agent is a
   genuine protocol participant.
5. **Information asymmetry is first-class.** The harness holds state. You control what
   each caller sees. State that never leaves the server is real security — "pretend you
   can't see this" is not.
6. **Start minimal, add facets.** A gather-only move can become an API contract move
   later. Don't pre-engineer facets you might not need.
7. **The harness is the referee.** The token system, schema validation, and caller
   distinction make interactions auditable, resumable, and safe.
8. **Conversational moves skip submit.** If the value is the conversation itself (not a
   structured artifact), use the companion pattern — no tokens, no TTL, no expiry.
   The agent writes files directly when the conversation winds down.

## MoveConfig Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Move identifier (matches directory name) |
| `label` | string | Display name in UI |
| `description` | string | What this move does |
| `icon` | string | Icon name for UI |
| `mode` | `"inline"` / `"branch"` / `"background"` | Execution mode (default: inline) |
| `inputs` | array | Form fields shown before activation (see Inputs below) |
| `schema` / `schemaHint` | string | Validation contract for modus_submit data |
| `submit.required` | boolean | Agent must call modus_submit |
| `submit.maxAttempts` | number | Cap on invalid submissions (default 3) |
| `persistent` | boolean | Re-run gather() every turn |
| `api` | object | API contract — `tokenPrefix`, `ops`, `state` |
| `widget` | object | Widget — `component`, `panel`, `label`, `autoOpen`, `mountOnAttach`, `cache` |
| `page` | object | Full page — `id`, `title`, `icon`, `nav` |
| `agentProfile` | string | Agent profile for branch/background sessions |
| `session.afterSubmit` | string | `"continue"` (keep going), `"end"` (close session), `"switch:<profile>"` (swap agent) |
| `session.profileOverride` | string | Temporarily swap agent profile for this move |
| `session.settingsOverride` | object | Override provider, model, effort, maxTurns, tools |
| `tags` | string[] | Categorization tags |

### Inputs

Inputs are form fields shown to the user before activation. Accessed via `ctx.inputs`
in gather().

```json
{
  "inputs": [
    {
      "name": "topic",
      "label": "Topic",
      "type": "textarea",
      "required": true,
      "placeholder": "What should we work on?"
    },
    {
      "name": "style",
      "label": "Style",
      "type": "select",
      "options": ["formal", "casual", "technical"],
      "default": "casual"
    }
  ]
}
```

Input types: `text`, `textarea`, `select`, `toggle`, `number`.

## Technical Reference

### MoveContext (gather / onSubmit)

```ts
interface MoveContext {
  moveName: string;
  sessionId: string;
  session: {
    lastAssistantText: string;
    seq: number;
    profile: string | undefined;
    exchangeCount: number;
  };
  cwd: string;
  userProfile: string | undefined;
  inputs: Record<string, unknown>;
  db: MoveDB;              // listSessions, getSession, searchSessions, getMoveHistory
  run: (cmd: string) => Promise<string>;
  harness: HarnessBridge;  // createSession, sendMessage, triggerAction, notify
  meta: (key: string, value: unknown) => void;
  token?: string;          // one-shot submit token (10min TTL)
  schema?: string;         // schema hint string
  date?: string;           // current ISO date (YYYY-MM-DD)
  apiToken?: string;       // API contract token (mapi-{prefix}-{instanceId}, no TTL)
  instanceId?: string;     // API instance ID
}
```

### MoveApiContext (handlers)

```ts
interface MoveApiContext {
  instanceId: string;
  sessionId: string;
  moveName: string;
  cwd: string;
  caller: "agent" | "user";
  state: {
    get<T>(): Promise<T | undefined>;
    set(v: unknown): Promise<void>;
    delete(): Promise<void>;
  };
  notify: (message: string, emit?: { type: string; [key: string]: unknown }) => void;
}
```

### MoveModule (full context.ts export surface)

```ts
interface MoveModule {
  gather?(ctx: MoveContext): Promise<string | null>;
  onSubmit?(ctx: MoveContext, data: Record<string, unknown>,
            inputs: Record<string, unknown>): Promise<SubmitResult>;
  onAssistantTurn?(ctx: MoveAssistantTurnContext): Promise<void>;
  handlers?: Record<string, MoveApiHandler>;
  listInstances?(states: Array<{ instanceId: string; state: unknown }>):
    Array<{ label: string; value: string }>;
}
```

- **onAssistantTurn** — fires after each assistant response on an active instance.
  Used for multi-agent turn sequencing.
  See [references/multi-agent-moves.md](references/multi-agent-moves.md).
- **listInstances** — customize how saved instances appear in the resume picker.

### Key Rules

- **context.ts imports**: `import type { ... } from "../../../harness/move-types"`.
  Import db functions from `"../../../harness/db"` when needed.
- **gather() returns `string | null`** — string injects into the session, `null` bails.
- **API tokens**: `ctx.apiToken` is auto-created for API contract moves. No TTL.
  Pass it to the agent in gather().
- **Submit tokens**: `ctx.token` for one-shot submit. 10min TTL.
- **State**: `ctx.state` is NOT available in gather(). Handlers get
  `ctx.state.get<T>()` / `.set(value)` / `.delete()`.
- **Notify**: for agent-called ops, `ctx.notify(message)` pushes into the agent
  session. For user/widget-called ops it does not inject; provide
  `ctx.notify("msg", { type: "event-name", ...payload })` to broadcast the typed
  payload to the widget instead.
- **Caller**: `ctx.caller` is `"agent"` or `"user"`. Default-deny for sensitive ops.
- **Inputs**: Declared in move.json `inputs[]`, read via `ctx.inputs` in gather().
- **DB**: `ctx.db` in gather() gives project-scoped session queries and move history.
  `listSessions()` and `searchSessions()` are scoped to the project CWD.
  `getMoveHistory(name)` returns this move's run history.
- **Shell**: `ctx.run(cmd)` executes a command and returns stdout.
- **Direct imports**: context.ts runs in the harness process — it can import any
  harness module (db, trace, etc.).
- **Widget CSS**: Put styles in `widget.css` next to `widget.tsx`. Auto-loaded by
  harness. Use `var(--*)` color tokens, `calc(Npx * var(--font-scale, 1))` for fonts.
- **No core edits needed** — moves are self-contained in `.modus/moves/<name>/`.


### Timeouts

- **Auto-gather** (persistent, ambient): 10s. Must return fast.
- **User-initiated activation** (widget `activate()`, user invoke): **2 minutes**.
  This is where heavy work goes — launching processes, polling services, creating sessions.

### Capability split: gather/onSubmit vs handlers

| Capability | `gather()` / `onSubmit()` | handlers (ops) |
|------------|---------------------------|----------------|
| `ctx.run()` (shell) | Yes | **No** |
| `ctx.harness.createSession()` | Yes | **No** |
| `ctx.harness.sendMessage()` | Yes | **No** |
| `ctx.state.get/set/delete` | **No** (read from disk directly) | Yes |
| `ctx.notify()` | No | Yes |
| `ctx.store/setStore` | Yes (API moves) | Yes |

**Widget-first moves that need to launch processes or create sessions MUST do it
in gather().** Ops are for lightweight state management only. The 2-minute activation
timeout exists for exactly this use case — gather() is the right place for heavy
async orchestration triggered by widget `activate()`.
