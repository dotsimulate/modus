# hints

Built-in launcher gate. Takes a rough intent and proposes **new sessions you
could open right now** — a project, a folder, an agent, and a short opening
message staged into the composer unsent so you edit it and hit send.

- **new** *(the default)* — open a new session with this agent, in this folder
- **session** — continue an existing conversation. The minority case: only when
  the work is literally mid-flight in that exact session
- **move** — run a move, including scaffolding moves like `create-profile`

**Past sessions are research, not the destination.** They tell the gate which
project the draft belongs to and what recently happened, so it can pick the
right agent and cite real material in `references`.

## How it runs

- Mode: `background` with `hidden: true` — the spawned session is tagged
  `internal`, so it never appears in the sidebar and is excluded from the FTS5
  search index queries that future runs read.
- Agent profile: **none declared**, so the gate inherits the user profile's
  `defaultAgentProfile` — usually a full coding agent, which is far more than a
  routing decision needs while someone waits. Pin one with the widget's
  `routerProfile` config rather than by forking this move; it rides on the
  move's `inputs`, and `buildSpawnSessionOpts` (`move-runner.ts:1688`) reads
  `inputs.agentProfile` **ahead of** `move.json`'s own `agentProfile`. Nothing
  named `hints` ships in the box.
- `gather()` pre-fetches candidates before the model runs: an unscoped FTS5
  pass (where does this live) plus a caller-scoped pass (guarantee the current
  project is represented), the project registry with per-folder agent profiles,
  the current project's moves, and the scaffolding taxonomy.
- `handlers` give the agent ops to verify with — see below.
- `onSubmit()` validates the payload and serializes it into the move run
  `summary` field. The stripping rules are the widget contract and are pinned
  by `harness/tests/hints-move.test.ts`.

## Ops available to the routing agent

Declared in `move.json` under `api.ops`. `activateMove` appends the ops protocol
to the prompt **before** it branches on mode, so a `background` move gets them.

| op | what it is for |
| --- | --- |
| `agents` | The agent catalog: every openable `(project, folder, agent)` triple with the profile's description and how many sessions have actually used it. `target` comes from here. Filterable by `project` / `query`, with a `sinceDays` usage window. |
| `search` | Cross-project FTS5. `sinceDays` narrows to recent work; `project` restricts to one project's folders. |
| `read` | The last few turns of a past session, so a `reason` can name what actually happened. |

## Consuming it

Frontend widget: `hints-launcher.widget.tsx`, reachable from any page that
lists the `hints-launcher` widget type (this project ships
`.modus/pages/launcher.json`). It runs its own grounded FTS5 pass immediately
so results are on screen with no model in the path, then calls
`activateProjectMove("hints", { query }, cwd)` in background mode, polls
`/api/move-runs/:id`, and merges the agent's cards above the grounded list.

Picking a card **stages** a launch — switch project, resume or create the
session, seed the composer draft via `queueComposerDraft`, navigate. It never
sends.

Payload shape:

```ts
{
  recommendations: Array<{
    kind: "new" | "session" | "move";
    target: string;        // agent profile key | session id | move name
    label: string;
    reason: string;
    prompt?: string;       // opening message, staged unsent and editable
    references?: string[]; // up to 4 lines, fenced below the prompt
    confidence?: number;   // 0-1
    project?: string;      // completed from `target` by onSubmit
    cwd?: string;          // completed from `target` by onSubmit
    profile?: string;      // mirrors `target` for kind "new"
  }>;
  passthrough: boolean;    // true → just send the draft as typed
  note?: string;
}
```

**The model only has to emit `kind`, `target`, `label`, `reason` and `prompt`.**
Everything derivable is derived: `onSubmit` maps `target` back to its project
and folder through the agent catalog. That is deliberate — see the module
comment in `context.ts` for the live run that made it necessary, and for why
rejecting an incomplete card is not an option here.

## Tuning

Override at project level by dropping a `move.json` in `.modus/moves/hints/`
with the same shape — project-local moves override built-ins of the same name.
Common knobs:

- `agentProfile` — a move-level default. Prefer the widget's `routerProfile`,
  which sets the same thing per page and needs no move fork.
- `hidden: false` — expose the spawned background session in the sidebar to
  debug a routing decision.
- The op budget line in `gather()` — raise it if you want the gate to read more
  candidate sessions before deciding, at the cost of latency.

To customize routing behavior itself, copy this move into `.modus/moves/hints/`
and edit `gather()`.

## A worked routing profile

`.modus/profiles/agents/hints-router.json` in this repo is the reference. The
parts that matter for any router, not just this one:

- **`tools: []`** — an explicit empty array, not an omitted key. Omitted means
  *inherit every tool*. On codex this derives `sandboxMode: "read-only"` and
  `webSearchMode: "disabled"` (`codex.ts:608-623`) and does **not** touch
  `modus_submit`, which arrives over the MCP bridge.
- **`permissionPolicy` left absent** (→ bypass). This is deliberate. A
  `permission_request` in a background session has no notify path and no
  timeout, so a gate that raises an approval card hangs that turn forever with
  nothing on screen. Contain it with the sandbox, not with an approval gate.
- **`effort: "low"`** — the turn is short, structured and mostly recall. A
  reasoning budget spent here is latency the user watches.
- **`loadProjectSettings: false`** — a router does not need the project's
  agent instructions, and reading them is pure latency.
- **`promptMode: "append"`** — `gather()` already carries the whole contract.
  `custom` replaces Codex's system instructions, which is more risk than a
  routing prompt is worth.

## Note on `session-projects`

`context.ts` imports `../../session-projects` at runtime, so that module is
listed in `harness/bridged-modules.ts`. A built-in move importing an unbridged
harness module works in dev and silently injects nothing in a packaged build;
`harness/tests/bridged-modules.test.ts` is the guard.
