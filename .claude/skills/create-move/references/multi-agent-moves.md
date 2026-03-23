# Multi-Agent Moves — Full Reference

Multi-agent moves orchestrate multiple agent sessions from a single move. The move
spawns sessions, manages turn sequencing, and coordinates communication between agents.
The canonical example is the `council` move.

## Architecture

```
User activates move (via widget or chat)
  → gather() spawns N agent sessions via ctx.harness.createSession()
  → Move tracks sessions in its own state
  → onAssistantTurn() hook reacts to each agent's responses
  → Handler logic sequences turns, routes messages, detects completion
  → Widget shows progress/state in real-time
```

The harness is the referee — agents never talk to each other directly. All communication
goes through the move's handlers and state.

## Key exports

Multi-agent moves typically export:

```ts
import type {
  MoveContext,
  MoveApiContext,
  MoveApiHandler,
  MoveAssistantTurnContext,
} from "../../../harness/move-types";

// 1. gather() — set up the orchestration
export async function gather(ctx: MoveContext): Promise<string | null> { ... }

// 2. onAssistantTurn() — react to each agent's response
export async function onAssistantTurn(ctx: MoveAssistantTurnContext): Promise<void> { ... }

// 3. handlers — user/widget interaction ops
export const handlers: Record<string, MoveApiHandler> = { ... };

// 4. listInstances — customize resume picker
export function listInstances(states: Array<{ instanceId: string; state: unknown }>) { ... }
```

## MoveAssistantTurnContext

Called after each assistant response on an active move instance:

```ts
interface MoveAssistantTurnContext {
  instanceId: string;
  sessionId: string;           // the session that just responded
  moveName: string;
  cwd: string;
  userProfile: string | undefined;
  state: MoveStateAPI;         // get/set/delete
  session: {
    lastAssistantText: string; // what the agent just said
    seq: number;
    profile: string | undefined;
    exchangeCount: number;
  };
  assistant: TurnContent;      // full structured turn content
  emit: (event: { type: string; payload?: Record<string, unknown> }) => void;
}
```

Use `ctx.emit({ type: "turn-complete", payload: { ... } })` to push events to the widget.

## Spawning sessions

Use `ctx.harness.createSession()` in gather() to spawn agent sessions:

```ts
export async function gather(ctx: MoveContext): Promise<string | null> {
  const state = await initState(ctx);

  for (const member of state.members) {
    const sessionId = await ctx.harness.createSession({
      profile: member.profile,
      prompt: buildPrompt(member, state),
      cwd: ctx.cwd,
      userProfile: ctx.userProfile,
      tags: [`council:${ctx.instanceId}`, `member:${member.name}`],
    });
    member.sessionId = sessionId;
  }

  // Save state so onAssistantTurn can access it
  // (state management depends on whether you use api.state or module-level maps)

  return null; // or return a summary prompt for the originating session
}
```

## Turn sequencing pattern (from council)

The council move demonstrates the core multi-agent orchestration loop:

1. **Setup**: gather() creates sessions for each member
2. **Watch**: onAssistantTurn() fires when any member responds
3. **Advance**: After a response, the move sends the next prompt to the next member
4. **Coordinate**: Each member sees a curated view of the discussion (not raw transcripts)
5. **Complete**: After N rounds or a judge verdict, the move marks itself done

```ts
export async function onAssistantTurn(ctx: MoveAssistantTurnContext): Promise<void> {
  const state = await ctx.state.get<CouncilState>();
  if (!state || state.status !== "active") return;

  // Find which member just responded
  const member = state.members.find(m => m.sessionId === ctx.sessionId);
  if (!member) return;

  // Record the response
  state.messages.push({
    member: member.name,
    content: ctx.session.lastAssistantText,
    round: state.currentRound,
  });

  // Advance to next member or next round
  await advanceTurn(ctx, state);
  await ctx.state.set(state);

  // Notify widget of update
  ctx.emit({ type: "council-update", payload: { round: state.currentRound } });
}
```

## Sending messages to spawned sessions

Use `ctx.harness.sendMessage()` to inject prompts into spawned sessions:

```ts
await ctx.harness.sendMessage(member.sessionId, buildNextPrompt(member, state));
```

## Module-level state vs API state

Multi-agent moves often need both:

- **API state** (`ctx.state.get/set`): Persisted, survives restart. Good for the canonical
  state (members, messages, rounds, status).
- **Module-level Maps**: In-memory, fast. Good for tracking active watchers, session-to-instance
  mappings, and ephemeral coordination state that doesn't need persistence.

```ts
// Module-level tracker — lost on restart but fast
const activeCouncils = new Map<string, CouncilTracker>();

// API state — persisted
interface CouncilState {
  topic: string;
  members: CouncilMember[];
  messages: CouncilMessage[];
  currentRound: number;
  status: "setup" | "active" | "complete";
}
```

## Widget integration

Multi-agent widgets typically show:
- Current state/round
- Messages from each agent
- Controls (start, broadcast message, stop)

The widget polls state via `callOp("read-state")` or receives events via SSE when
handlers call `ctx.emit()`.

## Common ops for multi-agent moves

| Op | Purpose |
|----|---------|
| `setup` | Configure before starting (topic, members, rounds) |
| `read-state` | Get current orchestration state |
| `broadcast` | Send a message visible to all members |
| `list-councils` | Show past instances |
| `read-instance` | Read a specific past instance |

## Design principles

- **Harness as referee**: Agents never communicate directly. The move mediates everything.
- **Information asymmetry**: Each agent sees only what the move decides to show it.
  Don't dump raw transcripts — curate prompts per member based on their role/stance.
- **Typed events**: Use `ctx.emit()` with structured payloads so the widget can react
  without polling.
- **Graceful degradation**: If a session errors or stalls, the move should handle it
  (skip the member, retry, or end the round) rather than hanging.
