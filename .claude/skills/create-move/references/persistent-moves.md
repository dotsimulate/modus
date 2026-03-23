# Persistent (Ambient) Moves — Full Reference

Persistent moves inject context into every turn. Their `gather()` re-runs on each user
message and appends output to the prompt. The agent doesn't need to know it's happening —
it's ambient context injection. Think RAG, live status, or project rules.

## move.json — minimal

```json
{
  "name": "my-ambient",
  "label": "My Ambient Context",
  "description": "What this ambient move injects and when",
  "icon": "radio",
  "persistent": true,
  "tags": ["ambient"]
}
```

That's it. No `submit`, no `api`, no `mode`, no `session`. Persistent moves are the
simplest possible move — just `persistent: true` and a `gather()`.

## context.ts — the gather pattern

```ts
import type { MoveContext } from "../../../harness/move-types";

export async function gather(ctx: MoveContext): Promise<string | null> {
  // Gather context — this runs on EVERY user message while the move is active
  const data = await ctx.run("git status --short");

  // Return null to bail — nothing injected this turn
  if (!data.trim()) return null;

  // Return string to inject into the prompt
  return `## Git Status\n\`\`\`\n${data}\n\`\`\``;
}
```

### Gather-bail is critical

Persistent gathers run every turn. If the context hasn't changed or isn't relevant,
**return `null`** to skip injection. This saves tokens and keeps the prompt clean.

```ts
// Good: bail when nothing to inject
if (paths.length === 0) return null;

// Bad: return empty string (still injected, wastes tokens)
if (paths.length === 0) return "";
```

## Lifecycle

```
User activates persistent move (via moves widget or API)
  → Move registered in ambient registry
  → UI shows toggleable chip in ChatInput

User sends a message
  → session-manager calls gatherAmbientContext()
  → Each active persistent move's gather() runs
  → Non-null results are prepended to the user message
  → Agent sees the gathered context as part of the prompt

User deactivates (toggle off or detach)
  → Move removed from ambient registry
  → No more per-turn gathers
```

## What gather() can access

Persistent moves have the full `MoveContext`:

| Field | Use case |
|-------|----------|
| `ctx.run(cmd)` | Shell commands: git status, test results, file reads |
| `ctx.db.listSessions()` | Recent session activity (scoped to project CWD) |
| `ctx.db.searchSessions(q)` | Full-text search (scoped to project CWD) |
| `ctx.db.getMoveHistory(name)` | This move's run history |
| `ctx.session.exchangeCount` | How many turns have happened (gate on frequency) |
| `ctx.session.lastAssistantText` | What the agent just said (react to it) |
| `ctx.sessionId` | Look up UI state, traces, etc. |

**Direct imports** — context.ts is TypeScript in the harness process:

```ts
import { getSessionUiState } from "../../../harness/db";
import { queryTouches } from "../../../harness/trace";
```

## Canonical example: open-tabs

The simplest real persistent move. Reads open file tabs from the UI state and injects
their paths so the agent knows what files the user is looking at.

```ts
import type { MoveContext } from "../../../harness/move-types";
import { getSessionUiState } from "../../../harness/db";

export async function gather(ctx: MoveContext): Promise<string | null> {
  const uiState = getSessionUiState(ctx.sessionId);
  const tabs = uiState.fileViewerTabs;

  if (!Array.isArray(tabs) || tabs.length === 0) return null;

  const paths = (tabs as Array<{ path: string }>)
    .map((t) => t.path)
    .filter((p) => typeof p === "string");

  if (paths.length === 0) return null;
  return `## Open Files\n${paths.map(p => `- ${p}`).join("\n")}`;
}
```

## Use cases

| Move idea | What gather() does |
|-----------|--------------------|
| **Live git context** | `ctx.run("git status --short && git log --oneline -3")` |
| **Test status** | `ctx.run("bun test --reporter=summary")`, bail if all pass |
| **Open files** | `getSessionUiState(ctx.sessionId).fileViewerTabs` |
| **Project rules** | Read config files based on `ctx.cwd`, inject relevant rules |
| **File touches** | `queryTouches(traceDb, { sessionId, ops: ["write", "edit"] })` |
| **Cost tracking** | Read session token counts, warn if high |
| **Behavioral modifier** | Return a short instruction string ("be terse", "explain steps") |

## Cost awareness

Every persistent gather adds tokens to every turn. Keep output short:

- Prefer bullet lists over paragraphs
- Bail early when context hasn't changed
- Consider checking `ctx.session.exchangeCount` to reduce frequency
  (e.g., only inject every 3rd turn)
- `string.length / 4` is a rough token estimate

## Persistent + API contract

A persistent move can also have an `api` block. This is unusual but valid — the ambient
gather runs every turn AND the agent can call ops. The `api` provides handlers for state
management while `persistent: true` provides the ambient injection.

## What persistent moves are NOT

Persistent moves are not actions. They don't run on a schedule — they run per-turn in an
active session. They don't spawn sessions — they inject into the current one. If you need
timed automation, use an action. If you need per-turn context injection, use a persistent move.
