---
name: session-reflect
description: Structured session reflection and memory consolidation. Reviews corrections, discoveries, and patterns from the current session and writes them as memory files. Invoke at session end or after significant learnings.
---

# Session Reflection Protocol

You are entering structured reflection mode. Review this session and persist what matters.

## Step 1 — Spike Detection

Scan the conversation for **spikes** — moments where normal flow was disrupted:

- **User corrections**: "no", "wrong", "not like that", or a redirected approach
- **Error recovery**: Something failed, user guided you to the fix
- **Unexpected specification**: User provided domain-specific detail you couldn't have guessed
- **Positive reinforcement after correction**: User confirmed the corrected approach worked

List each spike as a one-line summary. If there were no spikes (smooth session), say so and end — not every session produces learnings.

## Step 2 — Conflict Check

For each spike, use the `query` tool (Agent Memory server) to search for related existing memories or skills.

- **Conflicting memory found**: Present old vs new to the user. Ask which is correct. Edit or delete the old file as directed.
- **Matching skill found**: Flag to user if the skill contradicts the new learning. Do NOT edit skills here.
- **No conflicts**: Proceed.

## Step 3 — Write Memory Files

For each validated learning, create a markdown file in the memory directory.

**File naming**: Use a descriptive, hyphenated slug as the filename. This IS the memory ID.
- Good: `feedback-top-wiring-direction.md`, `cell-val-not-cell.md`
- Bad: `memory-001.md`, `thing-i-learned.md`, `4fb4c0c2.md`

**File format**:
```markdown
---
type: correction
tags: [feedback-top, wiring]
confidence: 0.9
created: YYYY-MM-DD
---

Feedback TOP's par.top must point to a DOWNSTREAM operator, not the source input.
The input connector receives the source. These must be different ops or you get a cook loop.
```

**Rules for content**:
- Write clear, actionable statements. Not narratives.
- A memory should be 1-5 lines. If it's longer, it should probably be a skill instead.
- Only persist user-specific, domain-specific, or project-specific learnings. General programming knowledge does not belong in memory.

**Type classification**:
| Type | When |
|------|------|
| correction | You were wrong, user fixed it |
| discovery | Non-obvious pattern found through experimentation |
| preference | User's personal workflow/style choice |
| hazard | Something broke or almost broke |

**Confidence**: 0.6 uncertain, 0.8 clear correction, 0.95 user-confirmed

**Tags**: Lowercase, hyphenated, specific.

## Step 4 — Skill Graduation Check

After writing memories, search broadly for each new memory's tags:

- If **3+ related memories** exist on the same topic, tell the user:
  "I have several memories about [topic]. Want to create a formal skill?"
- If they agree, **collaborate**: present what you know, let them refine, draft the SKILL.md together.
- **Never auto-generate skills.**

## Step 5 — Summary

Tell the user:
- How many spikes detected
- Which memory files were created (by name)
- Any conflicts found and resolved
- Any skill candidates identified
