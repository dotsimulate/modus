# Council

Multi-agent orchestration move. Spawns N agent sessions, chains their responses through a turn-based engine, and renders a live transcript in a widget panel.

Despite the name, it's not limited to debates — the configuration matrix (profiles × stances × response length × judge) supports brainstorming, creative jams, adversarial reviews, structured decision-making, and anything else that benefits from multiple agents taking turns on a shared topic.

## Quick Start

1. Attach the council move from the composer
2. Widget opens with setup screen — no message needed (`mountOnAttach`)
3. Configure: topic, rounds, response length, members
4. Hit **Convene Council** — agents spawn and begin

## Setup

| Field | Description |
|---|---|
| **Topic** | What the council discusses. Free-form text. |
| **Rounds** | Full rotation cycles. Each member speaks once per round. |
| **Response Length** | `rapid` (1-2 sentences), `short` (1 paragraph), `medium` (2-3), `long` (3-5) |
| **Members** | 2+ agents. Each has a name, agent profile, and stance. |
| **Judge** | Optional toggle. Speaks last after all rounds. Own profile + stance. |

## Stances

Stances are additive prompt instructions layered on top of the agent profile. Select **None** for pass-through — the profile's system prompt and tools determine behavior entirely.

| Stance | Angle |
|---|---|
| Advocate | Argues FOR |
| Skeptic | Challenges, probes weaknesses |
| Synthesizer | Integrates perspectives, finds common ground |
| Devil's Advocate | Contrarian — disrupts consensus |
| Pragmatist | What's practical and actionable |
| Visionary | Bold, creative, unconventional |
| Challenger | Edgy, provocative, questions sacred cows |
| Reframer | Zooms out, recontextualizes the question itself |
| Traditionalist | Defends proven approaches and precedent |
| Mediator | Builds bridges, finds compromise |

## API Ops

| Op | Description |
|---|---|
| `setup` | Configure the council (topic, members, rounds, responseLength) |
| `read-state` | Current state — messages, round, status, members |
| `list-councils` | Summaries of all past/current councils |
| `broadcast` | Inject a moderator message all members see on their next turn |

## How The Engine Works

- **Widget-first**: `mountOnAttach` means the widget opens on attach. User configures via `setup` op, then `activate()` triggers `gather()`.
- **Session spawning**: Each member gets a session with their profile + a composed prompt (stance + response length + no-tools footer). Sessions are tagged for sidebar visibility.
- **Two-phase init**: Sessions respond to their setup prompt first. Once all members have initialized, the debate starts.
- **Turn chaining**: `watchSessionExchanges` fires when a member responds. The engine records the message, advances the turn index, and pokes the next speaker.
- **Delta injection**: Each speaker only receives messages from OTHER members since their last turn. Their own prior responses are already in session history — no self-echo, no exponential growth.
- **Judge flow**: After all debate rounds, status transitions to `judging`. The judge receives the full transcript and delivers a verdict. Then `complete`.
- **State persistence**: `buildStateApi` (harness export) handles read/write to `.modus/moves/council/state/<instanceId>.json`.

## Known Limitations

- **Module-level Map**: Active council trackers live in a `Map` inside the module. If `move-runner` reloads the module (cache bust), the Map is lost and watchers die silently. A process-scoped instance store in move-runner would fix this.
- **Past council viewing**: The history view lists councils but reading arbitrary past instances requires a `read-instance` op (not yet built — currently only reads the active instance).
- **Profile list is static**: The widget has a hardcoded array of profiles. Should fetch from harness API.

## Files

```
.modus/moves/council/
├── move.json      # API contract, widget declaration, ops
├── context.ts     # Engine — gather, handlers, stances, turn logic
├── widget.tsx     # Setup screen, live debate, history browser
├── README.md
└── state/         # Runtime — persisted council instances (gitignored)
```
