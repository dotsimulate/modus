# hints

Built-in intent gate. Takes a user's draft prompt and recommends one of:

- **session** — continue an existing conversation (FTS5 scoped to cwd + user profile)
- **move** — run a move, including built-in scaffolding moves like
  `create-profile`, `create-page`, `create-move`, `create-action`,
  `create-mission`, `create-theme`, `handoff`
- **profile** — start a new session with a specific agent profile

## How it runs

- Mode: `background` with `hidden: true` (spawned session is tagged
  `internal` so it never appears in the session sidebar)
- Agent profile: `hints` (OpenRouter + `openai/gpt-4o-mini`, `maxOutputTokens: 800`)
- `gather()` pre-fetches candidate sessions, moves (lexical + scaffolding),
  and profiles before the model ever runs. The model just ranks and returns JSON.
- `onSubmit()` validates the payload and serializes it into the move run
  `summary` field.
- The agent has no tools beyond `modus_submit`.

## Consuming it

Frontend widget: `hints-launcher.widget.tsx`. It calls
`activateProjectMove("hints", { query }, cwd)` in background mode, polls
`/api/move-runs/:id` until `status === "completed"`, then parses `summary`
as JSON and renders cards.

Payload shape:

```ts
{
  recommendations: Array<{
    kind: "session" | "move" | "profile";
    target: string;     // session id | move name | profile name
    label: string;
    reason: string;
    confidence?: number; // 0-1
  }>;
  passthrough: boolean; // true → just send the draft as typed
  note?: string;
}
```

## Tuning

Override at project level by dropping a `move.json` in `.modus/moves/hints/`
with the same shape. Common knobs:

- `agentProfile` — swap to a different profile (default: `hints`)
- Override the `hints` profile itself in `.modus/profiles/agents/hints.json`
  to change the model (any OpenRouter or LiteLLM-compatible model works)
- `hidden: false` — expose the spawned background session in the sidebar for
  debugging routing decisions

To customize routing behavior itself, copy this move into `.modus/moves/hints/`
and edit `gather()` — project-local moves override built-ins of the same name.
