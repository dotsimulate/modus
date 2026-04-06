# Bootstrap

Bootstrap is the Modus pattern for giving an agent a durable, explicit, human-readable operational memory that gets loaded at session start and revised as the agent learns.

This document defines the Modus-specific idea of bootstrapping, the file and profile contracts that make it work, and the ethos behind the pattern.

## Definition

In Modus, bootstrapping means:

1. An agent starts a session by reading a curated memory artifact, usually a `BOOTSTRAP.md` file.
2. That artifact re-establishes the agent's domain, operating rules, current reality, startup steps, and durable lessons.
3. The agent executes the session using that artifact as its continuity layer instead of relying on long chat history.
4. Before the session ends, the agent writes back durable discoveries so the next fresh session starts better informed.

Bootstrap is not just "read some instructions." It is a continuity mechanism.

The key idea is that the session may be fresh, but the role is not. The bootstrap file carries the role's memory across sessions.

## Why Modus Uses It

Modus is built around agents that may:

- run in fresh sessions repeatedly
- switch providers and execution backends
- delegate to other agents
- work across long-lived projects where the important facts are operational, not conversational

Raw conversation history degrades. It gets noisy, expensive, stale, and difficult to trust. Bootstrap exists to keep the durable signal while discarding transient session chatter.

The pattern is especially valuable when:

- an orchestrator is intentionally reset between cycles
- the project has hard-won environment gotchas
- correctness depends on startup order
- the agent needs a stable operating record that a human can inspect and edit

## Core Ethos

Bootstrap is opinionated. Its ethos is:

- Fresh sessions are good.
- Durable memory should be explicit.
- The memory artifact should be readable by both humans and agents.
- The artifact should encode operational truth, not vague aspirations.
- Session-specific noise should be excluded or aggressively compressed.
- Every session should leave the next session better calibrated.

A good bootstrap file is not an append-only log and not a diary. It is a sharpened operational record.

## What Bootstrap Is

Bootstrap is:

- a startup contract
- a continuity layer across fresh sessions
- a curated memory artifact
- a source of durable constraints, rules, and known hazards
- a place to encode lessons that should survive session reset

Bootstrap is not:

- generic system prompt text
- raw conversation history
- vector memory or opaque retrieval
- a temporary scratchpad
- a dumping ground for per-session drift

## Relationship To Other Modus Primitives

## Agent Profile

The agent profile defines what the agent is allowed to do and how it should behave:

- model
- provider
- tools
- prompt
- permissions
- MCP servers

The profile can require a bootstrap file to be read at session start, but the profile is not the bootstrap itself.

Profile answers: "Who is this agent?"

Bootstrap answers: "What durable operational reality must this agent reload right now?"

## User Profile

The user profile scopes visibility, context, and template variables. It may influence the agent, but it is not the agent's memory.

User profile answers: "Who is using the system and what is in scope?"

Bootstrap answers: "What has this role learned and how should it resume work correctly?"

## Mission

Missions can use bootstrap as the continuity layer when sessions are intentionally reset.

The clearest built-in example is the fresh orchestrator pattern:

- `freshOrchestrator: true` starts a new orchestrator session each cycle
- the fresh session bootstraps from curated memory instead of relying on accumulated chat state
- the orchestrator updates its bootstrap before the cycle ends

In mission terms, bootstrap is how a role survives freshness.

## Memory Systems

Modus may also have other memory mechanisms, including MCP-backed memory stores and markdown memories. Bootstrap does not replace all of them. Instead, it fills a specific role:

- other memory systems can store broad knowledge
- bootstrap stores the minimum durable operating record a specific role must reload every time

Bootstrap is the most direct and inspectable form of role memory.

## The Bootstrap Contract

A Modus bootstrap pattern usually has two parts.

## 1. Profile Contract

The agent profile prompt establishes requirements such as:

- read `BOOTSTRAP.md` in full at session start
- treat it as the primary or sole source of persistent memory for that role
- follow its startup sequence before planning or editing
- update it before session end if durable lessons were learned

This is the behavioral contract.

## 2. File Contract

The `BOOTSTRAP.md` file contains the durable content the agent actually reloads.

This is the memory contract.

Together they create a loop:

1. Load the role memory.
2. Act in the world.
3. Distill durable lessons.
4. Write them back.
5. Start the next session fresh but informed.

## Recommended File Schema

Modus does not currently enforce a single JSON schema for `BOOTSTRAP.md`, but the pattern across working examples is consistent.

A strong bootstrap file usually contains:

## Header

- role name
- scope
- status
- authority level

Example concepts:

- "primary memory document for this agent"
- "sole source of persistent memory for this role"
- "living operational record"

## Flexibility Note

This section sets maintenance expectations:

- structured but not rigid
- compress when noisy
- prefer durable signal
- rewrite stale sections instead of endlessly appending

## Startup Sequence

An ordered list of what the agent must do before real work begins.

Examples:

- read this file in full
- initialize a module system
- inspect current runtime state
- read cycle context or delegation brief
- only then begin execution

This is what makes bootstrap operational instead of purely descriptive.

## Role Definition

Who the agent is in practice.

Examples:

- orchestrator vs builder
- explorer vs reviewer
- research role vs execution role

This section is narrower and more situational than a generic profile prompt.

## What To Produce

What the session is expected to emit:

- findings file
- report shape
- update targets
- handoff format

This keeps the role consistent across cycles.

## Domain Knowledge

The durable facts the role needs repeatedly:

- environment facts
- API gotchas
- runtime hazards
- path rules
- module usage patterns
- known failure modes

This is usually the most valuable section.

## Absolute Rules

Hard constraints that should survive every fresh session.

Examples:

- never touch protected paths
- never delete operators
- always verify before advancing
- always work in fresh staging areas

## Self-Improvement Rules

What belongs in the bootstrap file and what does not.

This is crucial. Without it, bootstrap files become junk drawers.

## Recommended Maintenance Rules

If you adopt bootstrap in Modus, keep these rules:

- Add only durable lessons.
- Exclude per-session chatter.
- Prefer rewrites over append-only growth.
- Preserve concrete facts over abstractions.
- Date time-sensitive operational facts when useful.
- Record why a rule exists, not just the rule.
- Keep startup steps executable and ordered.
- Make the file readable in one pass when possible.

## Bootstrap Lifecycle

A healthy bootstrap-enabled role usually follows this lifecycle:

1. Session starts fresh.
2. Agent reads `BOOTSTRAP.md`.
3. Agent performs any startup initialization defined there.
4. Agent executes the task or cycle.
5. Agent identifies durable lessons worth keeping.
6. Agent updates the bootstrap artifact.
7. Session ends.
8. Next session starts fresh and repeats.

This means the role improves without requiring long session persistence.

## Mission Bootstrap Pattern

Within Modus missions, bootstrap matters most when using cycling with fresh orchestrators.

Observed pattern:

- each cycle begins in a new orchestrator session
- previous work is summarized into a preamble
- the bootstrap or memory file is the main source of continuity
- the orchestrator updates the bootstrap before yielding control

This gives Modus a disciplined alternative to "keep the same agent alive forever."

The design tradeoff is intentional:

- persistent session state is convenient but degrades
- fresh sessions are cleaner but forgetful
- bootstrap recovers continuity without carrying full conversational baggage

## Bootstrapping Versus Prompting

Prompting tells the model how to behave.

Bootstrapping tells the role what durable reality it must reload.

Prompts are usually static or slow-moving.

Bootstrap files are expected to evolve with actual project discoveries.

If a prompt says:

- "be careful with runtime hazards"

and a bootstrap file says:

- "port 8001 was occupied by `acestep-api` on 2026-04-04; verify before assuming the model server owns it"

the bootstrap file is doing the real operational work.

## Bootstrapping Versus Memory Retrieval

Retrieval systems are useful, but bootstrap differs in important ways:

- it is deterministic
- it is role-scoped
- it is human-auditable
- it loads at the start, not opportunistically
- it encodes explicit startup behavior, not just facts

Bootstrap is closer to "reload the operator manual for this role" than "search memory when needed."

## Common Failure Modes

Bootstrap fails when:

- the file becomes an unfiltered log
- session-specific details bury durable rules
- the profile says to read it but the agent ignores it
- the startup sequence is vague or non-executable
- the role writes trivia back into the file every session
- the file grows too large to read reliably
- there is no distinction between stable memory and temporary context

## Signals Of A Good Bootstrap File

A strong bootstrap file has these properties:

- a fresh agent can read it and operate correctly with minimal warmup
- a human can inspect it and understand the role quickly
- it captures real failure-preventing knowledge
- it reduces repeated rediscovery
- it makes fresh-session operation viable
- it stays concise enough to remain trustworthy

## Minimal Example

```md
# Example Agent Bootstrap

Scope: `src/payments/`, Stripe webhook flows, retry semantics
Status: LIVING OPERATIONAL RECORD
Authority: PRIMARY MEMORY DOCUMENT FOR THIS AGENT

## Startup Sequence

1. Read this file in full.
2. Read `docs/payments-architecture.md`.
3. Check current webhook retry state in `logs/stripe-events/`.
4. Only then begin edits.

## Known Hazards

- Webhook events may arrive out of order.
- Local replay can duplicate side effects if idempotency keys are ignored.

## Absolute Rules

- Never change webhook signature verification without a failing test.
- Never assume staging and production secrets are interchangeable.

## Self-Improvement

If a new durable retry hazard is discovered, compress it into this file before ending the session.
```

## Modus-Specific Heuristic

For Modus, the cleanest mental model is:

Bootstrap = curated role memory + startup procedure + writeback discipline.

Not every agent needs it.

Use bootstrap when the role has enough durable operational knowledge that restarting without a curated reload would cause repeated mistakes, wasted turns, or unsafe assumptions.

## Current State In This Repo

As of 2026-04-06, this repository documents the bootstrap pattern in mission docs, but does not currently contain a canonical architecture doc for bootstrap outside this file.

The repo also does not guarantee that every mission role named in examples has a corresponding checked-in agent profile.

So this document is partly descriptive of current patterns and partly normative: it defines the intended Modus concept from the evidence already present in the repository and adjacent agent usage patterns.
