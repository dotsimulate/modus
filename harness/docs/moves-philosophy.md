---
title: Moves — Philosophy & Intent
lastUpdated: 2026-07-07
audience: dev
covers: harness/move-runner.ts harness/move-types.ts
---

# Moves — Philosophy & Intent

> This document is post-implementation reflection. It captures what moves turned
> out to be after the chess proof-of-concept shipped — not what they were
> theorized to be beforehand. Read it before building a move. It will save you
> from building the wrong thing.

---

## The Third Primitive

MO has three core primitives:

- **Profiles** — WHO the agent is (prompt, model, tools, permissions)
- **Actions** — WHEN automation runs (timers, webhooks, chains)
- **Moves** — WHAT the user wants done right now

Moves are the only user-present primitive. They activate in response to explicit
user intent. They produce a structured interaction — not just a conversation, but
a typed exchange with a verifiable contract at the center.

---

## What a Move Actually Is

A move is an activation context. When a user activates a move:

1. The harness runs `gather()` — collects any state, builds a prompt
2. A short-lived opaque token is generated (10min TTL, randomly generated, maps
   to session in server memory only — the model never sees a session ID)
3. The agent receives the token in its prompt along with instructions on how to use it
4. The agent works, then calls `modus_submit(token, data)` to finalize

The token is the contract. Without it, submission is rejected. It cannot be
guessed, reused across moves, or held past expiry. It is not a capability — it is
a lease on a specific, user-initiated operation.

---

## Two Patterns: Submit vs API Contract

**Submit moves** are one-shot. The agent does work, calls `modus_submit` once with
structured output, `onSubmit()` fires, done. Good for: code review, document draft,
structured analysis, anything that produces a single artifact.

**API contract moves** (`api` field in move.json) support repeated submission. The
agent receives an API token instead and can call named ops indefinitely until the
game or workflow concludes. Good for: games, multi-step interactive workflows,
anything where the state evolves through agent actions.

Both patterns use the same `modus_submit` tool. The token prefix tells the harness
which routing path to take.

---

## The Insight Chess Proved

Chess was chosen as the proof-of-concept because it exercises the full API contract
loop from start to finish. What it revealed:

**The move is the chat interface.**

When a user activates a chess move, the widget IS the interface. The user clicks
pieces. The agent responds through `modus_submit`. The conversation pane is
secondary — the game state is the primary communication channel. The agent does
not narrate its thinking into the chat; it acts through structured ops.

This is the general pattern. A well-designed API contract move replaces ad-hoc
back-and-forth conversation with a typed protocol. The chat becomes a log. The
widget becomes the interface. The harness becomes the referee.

---

## Information Asymmetry Is a First-Class Property

The harness holds state. The harness controls what each caller sees.

In chess: both players see the same board (no hidden information). But `ctx.caller`
distinguishes `"user"` (widget) from `"agent"` (modus_submit) — turn enforcement
is pure server logic, not a prompt instruction.

In Wordle: the answer lives in `state.answer`. The `guess` handler returns only the
result pattern — green/yellow/gray. The answer is never serialized into any response
the agent receives. "Pretend you can't see this" is not security. State that never
leaves the server is.

This is what separates moves from prompt engineering. You cannot prompt your way to
genuine information asymmetry. You can harness your way there.

---

## Moves Are Not Universal (That's a Feature)

Moves are domain-specific by design. A chess move knows about FEN strings. A Wordle
move knows about five-letter words. They do not try to be general-purpose task runners
— that's what agent profiles are for.

The specificity is what makes the token contract safe. Because `onSubmit()` or the
named handlers run server-side with full access to the filesystem, database, and
network, you want a narrow surface. The move declares exactly what ops exist. The
harness validates submissions against schema. Unknown ops are rejected.

General power + specific surface = safe extensibility.

---

## Moves vs Missions: Do Not Confuse These

**Moves** are user-present. The user activated this, the user is (probably) watching,
the interaction has a clear beginning and end. One user, one intent, one moment.

**Missions** are orchestrated workflows. They can involve multiple agents with
different roles, multi-step gates, information asymmetry between agents, and they
can run without a human watching. Missions use the same `modus_submit` tool via
mission tokens — but the routing, state model, and lifecycle are entirely different.

A chess move (one user vs one agent, user is present) is a move.
A chess mission (agent vs agent, harness enforces turn order, runs unattended) would
be a mission.

When you're deciding which to build: if the user needs to be there and participate,
it's a move. If you're orchestrating agents across time without a human in the loop,
it's a mission.

---

## The Extensibility Model

Project-local moves live in `.modus/moves/<name>/`. They override harness built-ins
of the same name. Zero core edits required.

```
.modus/moves/your-thing/
  move.json       — config: ops, schema, widget, mode
  context.ts      — gather(), handlers{}, listInstances()
  widget.tsx      — React component rendered in the right panel
```

The harness discovers and hot-reloads these. The agent profile sees no difference
between a built-in move and a project-local one. The token system is the same.
The `callOp` in the widget is the same. Everything composes.

This means: if you want to test a new op pattern, a new widget layout, or a new
game mechanic — create a directory, write three files, activate. No server restart,
no core code changes.

---

## What Moves Are Not

- Not a universal task interface — use agent profiles for open-ended work
- Not a mission — don't model multi-agent orchestration as a move
- Not a tool injection — the agent doesn't discover moves; the user activates them
- Not a persistent automation — that's actions

The token contract, the structured ops, the widget, the harness validation — these
add friction on purpose. That friction is what makes the interaction auditable,
resumable, and safe to grant real side effects.

---

## State and Resumability

API contract moves persist state to disk (`ctx.state.get/set`). Games survive
session restarts. A Wordle game started in one session can be resumed in another.
The `listInstances` export in `context.ts` lets you label instances for the UI.

State is keyed by instance ID, not session ID. This means:
- Multiple concurrent games of the same move type are possible
- The agent can pick up where it left off after a timeout
- The widget reads the same state the agent writes to

State is a typed interface. Write it typed, read it typed. The harness doesn't care
about the shape — your handlers own the contract.

---

## Summary

A move is a user-initiated, token-gated, harness-validated interaction with an agent.
At its best, it turns the right panel into a first-class interface and the agent into
a protocol participant — not a conversationalist. The chat log becomes secondary.
The structured exchange is primary.

Build domain-specific moves. Trust the token. Let the harness be the referee.
