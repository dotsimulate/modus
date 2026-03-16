# Handoff Move

Writes a persistent markdown document and delegates to a new session with a target profile. The document is the transfer artifact — the receiving agent reads it to orient before starting work.

## How It Works

1. User activates the move, picks a target agent, types a focus description
2. The writing agent gets session context (git state, touched files) and document instructions
3. Agent writes a markdown file to `.modus/handoffs/`, then calls `modus_submit` with metadata
4. `onSubmit` creates a new session with the target profile and injects a delegate prompt pointing to the document
5. The new agent starts cold — its only context is its profile prompt + the delegate message

The handoff document persists on disk. Sessions linked by handoffs appear as edges in the Session Web view, with the document as a node between them.

## Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| Target agent | select | Current profile | Which agent profile receives the handoff |
| What to hand off | textarea | (required) | Free-text description of what to transfer |
| Handoff type | select | task | Frames the document: `task`, `research`, `review`, `bug-fix`, `discussion` |
| Document style | select | briefing | Controls document structure (see below) |
| Include user tips | toggle | yes | Whether to include observations about user working style |

## Document Styles

### `briefing`

The original and most thorough style. Produces a structured document with rigid sections in order:

- **GROUNDING** — Current state, key decisions, open issues. 4-8 bullets.
- **RESOURCES** — File paths and URLs organized as must-read, context, produced.
- **HOT PREP** — What to run first, traps to skip, mental model corrections.
- **TESTIMONY** — Direct address to the next agent. Opinionated synthesis. 3-5 sentences.
- **WORKING WITH THIS USER** — (optional) Preferences, workflow style, friction points.

Best for: cold-start agents, complex multi-file tasks, handoffs that may be read later.

### `compact`

Minimal structured transfer. No prose, no opinions, maximum density.

- **STATE** — What exists now. 3-5 bullets, facts only.
- **CHANGED** — Files modified with one-line descriptions. Omitted if nothing changed.
- **DO NEXT** — Ordered imperative action items.
- **WATCH OUT** — 1-3 known pitfalls. Omitted if none.

Target: under 40 lines. Best for: quick lateral handoffs, tight context windows, sequential pipeline stages.

### `narrative`

Flowing prose memo addressed directly to the receiving agent. No rigid sections — organized by importance. File paths and specifics are woven inline. Aims for 2-4 paragraphs.

Best for: research continuations, discussions, situations where reasoning chain matters more than file lists.

### `adaptive`

The model decides the structure. It can borrow from any of the above styles or invent its own format. Three constraints:

1. The document must be sufficient for the receiving agent to start without clarifying questions
2. File paths must be absolute
3. Don't pad — match document length to handoff complexity

Best for: when you don't want to prescribe structure and trust the model to judge what the handoff needs.

## Handoff Types

The type input changes a framing paragraph in the prompt that tells the writing agent how to orient the document content (not the structure — that's controlled by style).

| Type | Framing |
|------|---------|
| `task` | Work order: what to build, which files, steps, acceptance criteria |
| `research` | Research brief: findings, unknowns, hypotheses, where to look |
| `review` | Review brief: what changed, rationale, what to verify |
| `bug-fix` | Bug report: symptoms, tried, suspected cause, repro steps |
| `discussion` | Briefing: topic, positions, open questions, user's thinking |

## Submit Schema

```
{
  document: string,      // absolute path to the written markdown file
  nextSteps: string[],   // ordered action items for the receiving agent
  priority?: 1-5,        // 1 = urgent, 5 = background
  commits?: string[],    // commit hashes the agent contributed to
  filesChanged?: string[], // file paths modified this session
  tags?: string[]        // freeform categorization tags
}
```

## Files

- `move.json` — Move config, inputs, schema hint
- `context.ts` — `gather()` builds the prompt, `onSubmit()` tags the session and creates the delegate session
