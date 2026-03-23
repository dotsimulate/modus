# Composition Patterns — Real Examples

Moves combine facets. These patterns show how facets compose in practice.

## Pattern 1: Widget-First Game — chess

**Facets:** API contract + mountOnAttach widget + stateful instances

```
move.json highlights:
  api.ops: setup, move, board, resign
  api.state.persist: true
  widget.mountOnAttach: true
  widget.autoOpen: true
  submit.required: false
```

**Flow:**
1. Widget opens immediately (mountOnAttach)
2. User picks color via widget → `callOp("setup", { userColor: "w" })`
3. User clicks "Start Game" → `activate()` fires gather()
4. gather() reads setup state, returns game instructions + API token
5. Agent plays via modus_submit ops (move, board)
6. Widget shows board state, updated after each op

**Key lesson:** The widget drives configuration, the agent drives gameplay.
`activate()` is one-shot — after firing, it's gone.

## Pattern 2: Multi-Agent Orchestration — council

**Facets:** API contract + mountOnAttach widget + multi-agent + onAssistantTurn

```
move.json highlights:
  api.ops: setup, read-state, read-instance, list-councils, broadcast
  api.state.persist: true
  widget.mountOnAttach: true
  widget.autoOpen: true
  submit.required: false
```

**Flow:**
1. Widget opens (mountOnAttach), user configures topic + members via `callOp("setup")`
2. `activate()` fires gather() → spawns N agent sessions via `harness.createSession()`
3. `onAssistantTurn()` fires after each agent responds → advances to next member
4. Widget shows live discussion via `callOp("read-state")`
5. After N rounds, judge member delivers verdict

**Key lesson:** The move is the referee. Agents never see each other's raw output —
the move curates what each member receives. Module-level Maps track active sessions.

## Pattern 3: Full Page + Widget — memory

**Facets:** API contract + agent-first widget + full page

```
move.json highlights:
  api.ops: query, save, delete, list
  api.state.persist: false       ← stateless ops, memories stored externally
  widget.mountOnAttach: true
  widget.autoOpen: false
  page.id: "memory"
  page.title: "memory"
  page.nav: true
```

**Flow:**
- As a widget: right-panel tab for browsing/searching memories during a session
- As a page: full-screen memory browser accessible from the nav bar
- As an API: agent can query/save memories via ops during any session
- Same widget.tsx renders in both contexts (panel tab and full page)

**Key lesson:** `page` and `widget` are independent facets. A move can be a right-panel
utility AND a full app page. The same component serves both.

## Pattern 4: External API + Budget Control — fal-image

**Facets:** API contract + mountOnAttach widget + budget/security system

```
move.json highlights:
  api.ops: check-endpoint, generate, list, get-state, set-config, revoke-key, reissue-key, set-key-budget
  api.state.persist: true
  widget.mountOnAttach: true
  widget.cache: "instance"
```

**Flow:**
1. Widget opens, user configures endpoint + params + locks
2. `activate()` issues agent key with budget
3. Agent calls `generate` → handler checks budget, enforces param locks, calls fal.ai API
4. Widget shows generated images, key status, budget remaining
5. User can revoke/reissue keys, adjust budgets without re-activating

**Key lesson:** Caller-gated ops. `generate` checks the agent's budget and enforces
param locks. Config ops are widget-only (`ctx.caller === "user"`). `activate()` is
one-shot, so `reissue-key` op exists as a fallback for re-granting agent access.

## Pattern 5: Branch Pipeline — animate-this

**Facets:** API contract + agent-first widget + submit + branch session + inputs

```
move.json highlights:
  inputs: [topic (textarea, required), intent (textarea, optional)]
  schemaHint: "{ document: string, title: string, files?: string[] }"
  api.ops: status, log, done, error
  api.state.persist: true
  submit.required: true
  widget.autoOpen: true
  widget.cache: "instance"
```

**Flow:**
1. User fills in inputs (topic, intent) → activates
2. gather() reads inputs, returns brief-writing instructions + schema
3. Agent writes a motion graphics document, submits via modus_submit
4. onSubmit() spawns a Remotion animator session with the document
5. Spawned session builds + renders, reports progress via `log` op
6. Widget shows render progress, final video preview via `done` op

**Key lesson:** Two-phase: the originating agent writes the brief (submit move),
then onSubmit spawns a specialized agent (branch). The API ops let the spawned
session report back to the widget.

## Pattern 6: Minimal Ambient — open-tabs

**Facets:** Persistent only (no API, no widget, no submit)

```
move.json highlights:
  persistent: true
  (nothing else — no api, no widget, no submit, no mode)
```

**Flow:**
1. User toggles on via moves widget → registered in ambient registry
2. Every user message → gather() reads UI state → returns file paths or null
3. Agent sees open file paths as part of every prompt

**Key lesson:** The simplest possible move. Two fields in move.json, one function
in context.ts. Gather-bail (`return null`) is essential — skip injection when
nothing is open.

## Pattern 7: Companion — check-in

**Facets:** None (no API, no widget, no submit, no persistent)

```
move.json highlights:
  (no submit, no api, no widget, no persistent, no mode)
  Just name, label, description, icon, tags
```

**Flow:**
1. User activates check-in move
2. gather() reads memory files + last project status
3. gather() returns a conversational prompt
4. Agent has a natural conversation — asks follow-ups, explores topics
5. When conversation winds down, agent writes to memory/project-status.md and
   memory/check-in-history.md directly

**Key lesson:** The simplest move that produces the most value for companion agents.
No tokens, no TTL, no expiry — the conversation can run as long as it needs. Results
are persisted as files the agent reads in future sessions. See
[companion-moves.md](companion-moves.md) for the full pattern.

## Facet Composition Matrix

Shows which facets each real move uses:

| Move | API | Widget | mountOnAttach | Page | Persistent | Multi-agent | onAssistantTurn | Inputs | Submit | Companion |
|------|-----|--------|---------------|------|------------|-------------|-----------------|--------|--------|-----------|
| open-tabs | | | | | x | | | | | |
| check-in | | | | | | | | | | x |
| chess | x | x | x | | | | | | | |
| council | x | x | x | | | x | x | | | |
| memory | x | x | x | x | | | | | | |
| fal-image | x | x | x | | | | | | | |
| animate-this | x | x | | | | | | x | x | |
| wordle | x | x | | | | | | | | |
| bg-commit | | | | | | | | | | |

Most real moves combine 2-4 facets. The skill's job is helping you pick the right
combination, not forcing you into one category.
