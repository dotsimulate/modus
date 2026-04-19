# Modus Bootstrap Pattern

Bootstrapping in Modus means an agent profile explicitly points to a persistent markdown memory file and requires that file to be loaded at the start of every session. The profile prompt should name the agent's domain, tell the agent which bootstrap file to read, state that the file is the complete or sole persistent memory for that agent, and require the agent to update that file whenever it learns a durable fact. This creates a self-improving loop: the agent starts from a curated operational record, does work, then folds new lessons back into the same record so the next session begins smarter and more context-aware.

## Why use this

Use this pattern when you want agents to feel active, engaged, and domain-specific instead of stateless. It supports self-learning agents because durable knowledge is accumulated in a controlled place, not lost in chat history. It also makes profiles more operationally reliable: each agent has an explicit identity, startup sequence, scope, and memory contract.

## Profile prompt pattern

```
You are <agent-name> for <domain> working in <paths/scope>. At the start of every session, you MUST read `.modus/memory/<agent-name>/BOOTSTRAP.md` in full, treat it as the complete record and sole source of persistent memory for this agent, and follow its startup sequence before making plans or edits. Treat that bootstrap file as the authoritative operating document for this role. If you learn a durable fact, workflow rule, runtime hazard, naming convention, or system-specific constraint, you MUST update `.modus/memory/<agent-name>/BOOTSTRAP.md` before ending the session.
```

## Bootstrap file pattern

**File location:** `.modus/memory/<agent-name>/BOOTSTRAP.md`

**Recommended structure:**

```
# <Agent Name> Bootstrap

Scope: <what this agent handles>

Status: COMPLETE RECORD

Authority: SOLE SOURCE OF PERSISTENT MEMORY FOR THIS AGENT

## Startup Sequence

1. Read this file in full
2. Restate the current question in plain language
3. Read the local reality that bears on that question
4. If external facts are needed, use web search
5. Provide your domain-specific advice or work
6. Update this file if any durable lesson became clearer

## Operating Rules

- [Your domain-specific rules]
- [Constraints and guardrails]
- [Workflows this agent uses]

## Durable Facts Learned

- [Facts that matter for future sessions]
- [System-specific constraints]
- [Recurring hazards or patterns]

## Self-Improvement Loop

- Update this file with durable knowledge
- Compress old entries when they get noisy
- Prefer signal over session logs
```

## Example instance

See `.modus/memory/product-advisor-codex/BOOTSTRAP.md` for a real example of a bootstrapped agent with a complete operating record.

## Key principles

1. **The profile says who the agent is.** It names the domain, scope, and memory contract.
2. **The bootstrap file says how the agent works.** It contains all persistent knowledge, operating rules, and durable facts.
3. **The startup sequence is non-negotiable.** The agent reads the bootstrap file first, every session, before making plans.
4. **The self-improvement loop is the whole point.** Durable lessons get captured in the same file, creating a compounding knowledge base across sessions.
5. **The file is the agent's identity.** Not configuration, not a prompt, but a living record of what this agent knows and how it operates.

## Comparing to other memory systems

- **Chat history**: Lost when the session ends. Durable knowledge has no home.
- **Fixed prompt engineering**: Static rules that don't evolve. The agent learns nothing across sessions.
- **Vector embeddings + RAG**: Scalable but opaque. The agent has no direct control over what it remembers.
- **Bootstrap pattern**: Human-readable, agent-owned, directly editable, version-controllable, and self-improving. The agent reads its own memory file and updates it — making the memory contract explicit and verifiable.

## When to use bootstrapping

✅ Use when:
- You want agents to feel like distinct personas that grow over time
- Durable knowledge needs to be human-readable and editable
- The agent should have direct ownership of its memory
- You want a portable, version-controllable memory system
- The agent needs to start from a known operational state every session

❌ Don't use when:
- The agent has a single ephemeral task with no persistence requirement
- Memory scales to hundreds of thousands of facts (use vector DB instead)
- The system is fully opaque and agents never directly edit memory
