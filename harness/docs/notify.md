---
title: Notify & Channels
lastUpdated: 2026-07-07
covers: harness/notify.ts harness/profiles.ts (NotificationChannel)
---

# Notify & Channels

"Notify" historically meant three different things in MO. This doc names them and
documents the one that actually routes agent content to the outside world: **channel
egress**.

## The three meanings of notify

1. **Action status notify** (`NotifySpec` → `sendNotifications`). Declared per action,
   fires on run **status** (`done`/`error`/`exhausted`). The message is a metadata
   template (`{action}{run}{status}{error}{cost}{duration}{profile}`). It cannot carry
   arbitrary agent content — it reports run outcomes. See [actions](./actions.md).
2. **Channel egress** (`ctx.channels.send`). The real "send this content to Discord/Slack/
   a file" primitive. Free-form text + optional structured data. This is the one you want
   when an agent should push content out. See below.
3. **Session-inject** (`MoveApiContext.notify`). NOT a channel — it pushes a message into
   the agent's own session via `interactWithSession`. Different concept, different name;
   left untouched. See [moves](./moves.md).

All three coexist. Egress (2) and status-notify (1) share the same channel config and the
same egress primitive under the hood; session-inject (3) is unrelated.

## Channels

A channel is a **named sink that accepts content**, defined in `_global.json` under
`notificationChannels` (project-local `_global.json` merges over the base):

```json
{
  "notificationChannels": {
    "team":   { "type": "webhook", "url": "https://discord.com/api/webhooks/...", "contentField": "content" },
    "ops":    { "type": "webhook", "url": "https://hooks.slack.com/...", "bodyTemplate": "{\"text\":\"{text}\"}" },
    "audit":  { "type": "file", "path": ".modus/logs/notify.jsonl" }
  }
}
```

### Webhook body shaping (backwards-compatible)

`sendToChannel` (`notify.ts`) is the egress primitive. The webhook body is shaped by, in
priority order:

- **`bodyTemplate`** — a JSON string template. `{text}` is replaced with the message
  (JSON-escaped, quote-stripped so it drops inside the template's own quotes); `{data}`
  with the JSON-stringified data object. Slack: `{"text":"{text}"}`.
- **`contentField`** — shorthand: wrap the text under one key and merge `data` alongside.
  Discord: `"contentField": "content"` → `{"content": text, ...data}`.
- **default** — today's shape `{ message: text, ...data }`. Existing webhooks are unbroken
  because this is exactly what shipped before; `bodyTemplate`/`contentField` are opt-in.

`file` channels append one JSON line per send: `{ timestamp, message, ...data }`.

## Sending from extension code

Every server-side surface reaches channels the same way, through the Harness Context:

```ts
// move handler / action / api-handler op:
await ctx.channels.send("team", { text: "Build #482 shipped ✅", data: { build: 482 } });
```

- Moves: `ctx.harness.notify({ channel, body })` (legacy bridge shape) and
  `SubmitResult.notify` both now route to real egress (they were console.log stubs before).
- Move API handlers: `ctx.channels.send(...)` (newly available — handlers could not reach
  channels before).
- Actions: `ctx.channels.send(...)`, gated by the action's trust/capabilities.

`send` is gated by the `notify` capability at the namespace boundary (see
[harness-context](./harness-context.md)). It returns `{ ok, error? }` and never throws.

## Action status notifications

Unchanged. Actions declare `notify: NotifySpec[]` in `action.json`; the runner fires them
after each run via `sendNotifications`, which is now implemented on top of `sendToChannel`
— same `NotifySpec` contract, same templates, same body shape. No action config changes.

**Source**: `notify.ts`, `profiles.ts` (`NotificationChannel`), `profile-schemas.ts`.
