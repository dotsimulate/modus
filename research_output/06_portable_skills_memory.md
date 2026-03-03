# Portable Skills and Memory Systems for Agent Frameworks — Research Report
*Generated: 2026-03-02*

## Summary

The landscape of agent skill and memory systems has matured significantly since late 2024. The emergence of the Agent Skills open standard (agentskills.io), published by Anthropic in December 2025 and adopted by OpenAI, Google, Microsoft, and 20+ other platforms, has created the first genuinely portable skill format for AI coding agents. Skills are now a cross-platform commodity: a folder containing a SKILL.md file with YAML frontmatter and markdown instructions, optionally bundled with scripts and reference files, that any compliant agent can discover and execute. This is a meaningful shift from the vendor-locked plugin ecosystems that preceded it.

Memory systems remain more fragmented but are converging on common patterns. The strongest production architectures combine structured storage (SQLite or Postgres) with vector embeddings for semantic retrieval, using a hybrid search strategy that weights vector similarity at ~70% and keyword/BM25 at ~30%. OpenClaw, CrewAI, LangGraph, and Mem0 each implement variations of this pattern. Memory management — versioning, pruning, relevance decay, deduplication — is an active research area with clear best practices emerging: LLM-assisted consolidation for deduplication, time-decay scoring for relevance, and utility-based deletion for pruning.

For the specific setup in this workspace (Claude Code + .claude/skills/ + FastMCP memory server + CLAUDE.md), the most impactful evolution path is: (1) adopt SQLite-backed storage with vector extensions for the memory server, replacing or augmenting pure markdown; (2) use symlinks or a central skill repository to share skills across projects; (3) implement memory consolidation and decay scoring to prevent bloat; and (4) keep the SKILL.md format as-is, since it is now the industry standard.

---

## Findings

### 1. Claude Code Skill System Deep Dive

**Confidence: HIGH** — sourced from official Claude Code documentation and verified against the agentskills.io specification.

#### SKILL.md Format and Structure

Every skill is a directory containing a required `SKILL.md` file. The file has two parts:

1. **YAML Frontmatter** (between `---` markers): metadata fields
2. **Markdown Body**: instructions Claude follows when the skill is invoked

```yaml
---
name: my-skill
description: What this skill does and when to use it
disable-model-invocation: true   # optional
allowed-tools: Read, Grep        # optional
context: fork                    # optional
---

Step-by-step instructions here...
```

**Frontmatter fields** (all optional except description which is recommended):

| Field | Purpose |
|-------|---------|
| `name` | Display name; becomes the `/slash-command`. If omitted, uses directory name. Lowercase, hyphens, max 64 chars. |
| `description` | What the skill does and when to use it. Claude uses this for auto-discovery. Critical for skill selection. |
| `argument-hint` | Autocomplete hint, e.g. `[issue-number]` |
| `disable-model-invocation` | `true` = only user can invoke via `/name`. Prevents auto-loading. |
| `user-invocable` | `false` = hidden from `/` menu. Only Claude can load it. |
| `allowed-tools` | Tools Claude can use without permission when skill is active |
| `model` | Override model for this skill |
| `context` | `fork` = run in isolated subagent |
| `agent` | Which subagent type (`Explore`, `Plan`, `general-purpose`, or custom) |
| `hooks` | Lifecycle hooks scoped to this skill |

#### Progressive Disclosure Mechanism

Skills use a three-tier information loading pattern:

1. **Tier 1 — Discovery**: Only skill names and descriptions are loaded into the system prompt at session start. This consumes minimal context. Budget is 2% of context window with a fallback of ~16,000 characters (configurable via `SLASH_COMMAND_TOOL_CHAR_BUDGET`).
2. **Tier 2 — Full Load**: When Claude determines a skill is relevant (or the user invokes it), the complete SKILL.md content loads into conversation context.
3. **Tier 3 — On-Demand Resources**: Supporting files (templates, references, scripts) are loaded only when explicitly needed during execution.

Skill selection is performed by **pure LLM reasoning** — there is no algorithmic matching or intent detection at the code level. Claude reads the descriptions in the Skill tool prompt and decides which skill to use based on its understanding of the user's request.

#### Storage Locations and Priority

| Level | Path | Scope |
|-------|------|-------|
| Enterprise | Managed settings | All users in organization |
| Personal | `~/.claude/skills/<name>/SKILL.md` | All your projects |
| Project | `.claude/skills/<name>/SKILL.md` | This project only |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Where plugin is enabled |

Priority: enterprise > personal > project. Plugin skills use namespaced names (`plugin:skill`) to avoid conflicts.

**Automatic nested discovery**: When editing files in `packages/frontend/`, Claude also discovers skills from `packages/frontend/.claude/skills/`. This supports monorepo setups.

**Additional directories**: Skills in `.claude/skills/` within `--add-dir` directories are loaded and support live change detection.

#### Invocation Control Matrix

| Configuration | User can invoke | Claude can invoke | Context behavior |
|---------------|----------------|-------------------|------------------|
| Default | Yes | Yes | Description always in context; full skill loads on invoke |
| `disable-model-invocation: true` | Yes | No | Description NOT in context; loads only on user invoke |
| `user-invocable: false` | No | Yes | Description in context; loads when Claude invokes |

#### Dynamic Context Injection

The `` !`command` `` syntax runs shell commands before skill content is sent to Claude. Output replaces the placeholder:

```yaml
---
name: pr-summary
context: fork
---
PR diff: !`gh pr diff`
Changed files: !`gh pr diff --name-only`
```

#### String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when invoking |
| `$ARGUMENTS[N]` or `$N` | Specific argument by 0-based index |
| `${CLAUDE_SESSION_ID}` | Current session ID |

#### Bundled Skills

Claude Code ships with:
- `/simplify` — spawns three parallel review agents (code reuse, quality, efficiency)
- `/batch <instruction>` — orchestrates large-scale parallel changes across a codebase using git worktrees
- `/debug [description]` — reads session debug logs for troubleshooting

#### Limitations

- **Context budget cap**: With many skills, descriptions may exceed the character budget and some skills get excluded. Run `/context` to check.
- **Token overhead**: Each skill invocation costs ~1,500+ tokens for prompt expansion.
- **Not concurrency-safe**: Skills operate through prompt expansion, not direct execution.
- **No algorithmic matching**: Skill selection depends entirely on LLM reasoning quality, which means vague descriptions lead to missed or incorrect invocations.
- **`when_to_use` field**: Appears in source code but has no official documentation — likely experimental/deprecated. Use `description` instead.

---

### 2. Other Framework Skill/Plugin Systems

**Confidence: HIGH for smolagents, LangGraph, CrewAI; MEDIUM for OpenClaw/ClawHub specifics**

#### smolagents (HuggingFace)

**Architecture**: A minimalist agent library (~1,000 lines of core logic) where agents "think in code." Two agent types: `CodeAgent` (generates Python code) and `ToolCallingAgent` (structured tool calls).

**Tool Definition**: The `@tool` decorator converts a Python function into a tool. The decorator parses type hints from inputs/outputs and docstrings for descriptions:

```python
from smolagents import tool

@tool
def search_web(query: str) -> str:
    """Search the web for information about a topic."""
    # implementation
```

**Tool Sharing**: Tools can be pushed to and pulled from the Hugging Face Hub using `push_to_hub()`. Community tools are discoverable and installable. Also supports importing LangChain tools and connecting to HF Spaces.

**Multi-Agent**: Supports multi-agent setups where specialized agents collaborate on subtasks.

**Comparison to Claude Code Skills**: smolagents tools are code-first (Python functions), while Claude Code skills are prompt-first (markdown instructions). smolagents has a centralized sharing hub (HF Hub); Claude Code relies on git repos, plugins, or the emerging SkillsMP marketplace.

#### LangGraph / LangChain

**Architecture**: LangGraph is a graph-based state machine built on top of LangChain. Workflows are defined as nodes (handling prompts/subtasks) connected by edges (controlling flow and transitions). Reached v1.0 in October 2025.

**Tool Definition**: Tools are Python functions decorated with LangChain's tool decorators or wrapped in `Tool` objects. LangGraph adds explicit state management — tools can directly update agent state.

**Memory**: LangGraph expanded memory significantly in 2025:
- **LangMem SDK**: Structured long-term memory management
- **Cross-thread memory**: Agents share knowledge across conversations via namespaced stores
- **Semantic search**: Uses PostgreSQL + pgvector for production deployments
- **Memory types**: Thread-scoped (short-term) vs namespace-scoped (long-term)

LangMem's core API is storage-agnostic and can integrate with any storage backend.

**Comparison to Claude Code Skills**: LangGraph tools are programmatic (Python), stateful (explicit state graph), and deeply integrated with the orchestration framework. Claude Code skills are declarative (markdown), stateless (no persistent state between invocations), and loosely coupled. LangGraph's memory system is far more sophisticated out of the box.

#### CrewAI

**Architecture**: Role-based multi-agent framework. Agents have roles (Manager, Worker, Researcher), tools, and collaborate on structured tasks.

**Tool Definition**: 100+ built-in tools for web scraping, file processing, API interactions, vector DB queries. Custom tools are Python classes or functions. Tasks are defined with descriptions, assigned agents, required tools, and expected outputs.

**Memory System** (four types):
1. **Short-Term Memory**: ChromaDB + RAG for recent interactions within current execution
2. **Long-Term Memory**: SQLite3 for cross-session insights and task results
3. **Entity Memory**: RAG-based storage for entities (people, places, concepts)
4. **Contextual Memory**: Maintains coherence across conversation sequences

Memory uses LLM analysis on save to infer scope, categories, and importance. Retrieval uses composite scoring blending semantic similarity, recency, and importance.

**Comparison to Claude Code Skills**: CrewAI is the most opinionated framework — it prescribes agent roles and task structures. Its memory system is the most feature-rich among the compared frameworks, with four distinct memory types and LLM-assisted metadata inference. Claude Code skills are simpler and more flexible but lack built-in memory integration.

#### OpenClaw / ClawHub

**ClawHub**: OpenClaw's official skill registry — described as "npm for AI agents." As of February 2026, it hosts 13,729 community-built skills with semantic (vector) search, semver versioning, changelogs, and community features (stars, comments).

**Key Features**:
- Plain-language search powered by embeddings
- CLI-friendly API for programmatic install/update
- Security: GitHub account age requirement (1 week), community reporting (3 reports = auto-hide), moderator review, VirusTotal malware scanning

**Security Incident**: In February 2026, researchers discovered 341 malicious ClawHub skills stealing user data, plus 283 with critical security flaws. ~2,419 suspicious skills were removed. This highlights the fundamental security risk of community skill registries.

**Memory Architecture**: OpenClaw uses SQLite with a hybrid search approach:
- SQLite index at `~/.openclaw/memory/{agentId}.sqlite`
- Markdown files remain the canonical source; SQLite stores chunked embeddings as a derived index
- **Hybrid search**: Vector similarity (70% weight) + BM25 keyword search (30% weight) via SQLite FTS5
- Uses union (not intersection) — results from either search contribute
- Minimum score threshold of 0.35
- Achieves 89% recall vs 76% vector-only and 68% keyword-only

#### Cross-Framework Comparison

| Dimension | Claude Code | smolagents | LangGraph | CrewAI | OpenClaw |
|-----------|------------|------------|-----------|--------|----------|
| **Skill Format** | SKILL.md (markdown) | Python @tool | Python functions | Python classes | SKILL.md-compatible |
| **Sharing** | Git/plugins/SkillsMP | HuggingFace Hub | Python packages | Python packages | ClawHub registry |
| **Discovery** | LLM reasoning | Explicit registration | Explicit registration | Role-based assignment | Vector search |
| **Memory** | External (MCP) | None built-in | LangMem SDK | 4-type system | SQLite + hybrid search |
| **Multi-Agent** | Subagents/fork | Multi-agent | Graph-based orchestration | Role-based crews | Single agent focus |
| **Portability** | High (open standard) | Medium (Python-only) | Medium (Python-only) | Low (CrewAI-specific) | Medium (registry-locked) |

---

### 3. Memory System Patterns

**Confidence: HIGH for architecture patterns; MEDIUM for specific performance claims**

#### Beyond Markdown Files

Pure markdown files work for prototyping and small-scale use but hit clear walls:

| Limitation | Impact |
|-----------|--------|
| No concurrency | File locking prevents simultaneous writes |
| No transactions | No rollback on failure |
| Linear search | Read latencies grow linearly with file count (1-100ms) |
| No semantic search | Must match exact text or rely on file naming |
| Scales poorly | Performance degrades past thousands of files |

The markdown-only approach (like our current MCP memory server) is best suited for single-agent prototypes and personal assistants where the total memory store stays under a few hundred entries.

#### Vector Store Approaches

**ChromaDB**:
- Open-source, Python-native, targets LLM developers
- Quick local setup, good for development
- Lacks production features (observability, HA, security filtering)
- Used by CrewAI for short-term memory

**FAISS (Facebook AI Similarity Search)**:
- Library, not a database — focuses on vector indexing/search algorithms
- Sub-millisecond query latency for in-memory datasets
- No built-in persistence, metadata filtering, or concurrent access
- Best for: embedded search in single-process applications

**Qdrant**:
- Written in Rust, HTTP API, powerful metadata filtering
- Supports hybrid search (semantic + structured filters)
- Production-ready: clustering, snapshots, RBAC
- Used by Mem0/OpenMemory as vector backend

**SQLite-vec / sqlite-vss**:
- Vector extensions for SQLite
- Single-file, zero-configuration, ACID-compliant
- Combines structured queries with vector similarity in one database
- Used by OpenClaw for its hybrid search implementation

**Recommendation**: For a local-first agent memory system, SQLite with vector extensions provides the best balance of simplicity, performance, and capability. It avoids the operational burden of a separate vector database while supporting both structured queries and semantic search.

#### SQLite-Based Memory

SQLite is emerging as the sweet spot for agent memory:

- **ACID compliance** with WAL (Write-Ahead Logging) for crash safety
- **Compact**: 39MB overhead for 0.5GB of data
- **Fast**: 1-10ms for indexed key lookups
- **Vector support**: sqlite-vec extension enables semantic search
- **FTS5**: Built-in full-text search for keyword matching
- **Zero configuration**: Single file, no server process
- **Portable**: The database file can be copied, backed up, or moved trivially

**Memori** (GibsonAI, September 2025) provides a production-ready SQL-native memory engine that works with SQLite, PostgreSQL, or MySQL. Enables persistent, queryable memory with a single line of code.

#### Hybrid Approaches: Structured Metadata + Vector Search

The strongest pattern emerging in 2025-2026 combines:

1. **Structured metadata** in relational columns (timestamps, tags, categories, importance scores, access counts)
2. **Vector embeddings** for semantic similarity search
3. **Full-text indexes** (FTS5/BM25) for keyword matching
4. **Composite scoring** that blends semantic similarity, keyword relevance, recency, and importance

OpenClaw's implementation is the clearest reference: 70% vector + 30% BM25 with a 0.35 minimum score threshold. This hybrid achieves 89% recall vs 76% for vector-only.

**QMD (Query Markup Documents)**, created by Tobi Lutke (Shopify), takes another approach: hybrid search with LLM re-ranking. It runs vector and keyword searches in parallel, merges via Reciprocal Rank Fusion, then re-ranks with a local language model.

#### MCP Memory Server Patterns

Several patterns are emerging for MCP-based memory:

**FastMCP 2.13** ("Cache Me If You Can") added pluggable storage backends for persistent state. FastMCP 2.10 achieved full compliance with the June 2025 MCP spec update.

**Common MCP memory tools**: `memory_read`, `memory_write`, `memory_consolidate`, `memory_forget`, `memory_stats`.

**Mem0 OpenMemory**: A local-first MCP memory server using Docker (FastAPI + Postgres + Qdrant). Provides add_memories(), search_memory(), list_memories() via SSE. Each interaction is logged for traceability. Works with any MCP-compatible client (Cursor, VS Code, JetBrains, Claude, etc.).

**Architecture patterns for MCP memory servers**:
- **Hot cache + semantic search**: Two-tier approach with 0ms hot cache for recent items and vector search for older memories
- **Knowledge graph**: SQLite storing entities, observations, and relationships with BGE-M3 embeddings
- **Markdown Bank + index**: Markdown files as canonical source, SQLite as derived search index (OpenClaw pattern)

---

### 4. Memory Management Strategies

**Confidence: MEDIUM-HIGH — synthesized from academic papers, production implementations, and framework documentation**

#### Versioning

**Git-style versioning** is the most promising pattern for memory stores:
- Commit/branch/merge semantics applied to memory state
- Git-Context-Controller implements versioned hierarchy with rollback
- Each memory mutation is logged as a "commit" with timestamp, operation type, and diff
- Enables rollback from memory drift, hallucinations, or contamination

**Practical implementation**: Use a `memory_history` table in SQLite that records every write/update/delete with timestamps and the previous value. This provides full audit trail without the complexity of actual git.

#### Pruning and Compaction

Strategies ranked by effectiveness:

1. **Utility-based deletion**: Track access frequency and recency per memory. Low utility = candidate for decay. Research shows up to 10% performance gains from intelligent pruning vs naive approaches.

2. **Epochal summarization**: Rather than deleting old memories, periodically summarize N oldest memories into one condensed entry. Carries forward key facts while reducing count.

3. **Time-to-live (TTL)**: Set expiration on memories that are inherently temporal (e.g., "current task context"). Auto-expire after configurable duration unless reinforced.

4. **Dynamic summarization**: Maintain a living summary that updates over time. Keep last N items in full + a compact summary of everything older.

5. **Attention-based pruning** (H2O pattern): Dynamically prune less relevant entries based on actual usage patterns.

**Anti-pattern**: Indiscriminate deletion. Research shows that naive pruning strategies "propagate errors and degrade long-term agent performance."

#### Relevance Decay

Memory items can transition through states based on access patterns, time decay, and task labels:

```
Generated → Activated → Merged → Archived → Expired
```

**Scoring formula** (composite):
```
relevance = (semantic_similarity × w1) + (recency_score × w2) + (importance × w3) + (access_frequency × w4)
```

Where `recency_score` decays over time (exponential or linear decay). Typical weights: semantic 0.4, recency 0.3, importance 0.2, access 0.1.

**Reinforcement**: When a memory is accessed, its recency score resets and importance may increase. This implements a "use it or lose it" pattern that mirrors human memory consolidation.

#### Skill Graduation

Pattern for promoting observed behaviors to permanent skills:

1. **Track corrections**: Every time the user corrects the agent, log the correction with context
2. **Count recurrence**: When the same pattern appears N times (suggested: 3-5), flag for promotion
3. **Validate**: Before creating a skill, verify the pattern is genuinely reusable (not project-specific)
4. **Graduate**: Create a SKILL.md from the accumulated corrections and verified patterns
5. **Retire memories**: Once a skill exists, archive the individual memory entries that led to it

This is essentially what our `skill-creator` and `session-reflect` skills implement manually. Automating the detection step (counting recurrences) would be the next evolution.

#### Memory Deduplication

**LLM-assisted consolidation** is the dominant approach:

1. For each new memory, retrieve top-K semantically similar existing memories
2. Send new + retrieved memories to LLM with a consolidation prompt
3. LLM decides: merge (semantically equivalent), update (newer info supersedes), or keep both (genuinely distinct)
4. Example: "loves pizza" and "likes pizza" are merged; "allergic to peanuts" supersedes "enjoys peanut butter"

**Key implementation details**:
- Scope consolidation to same namespace/category to avoid cross-contamination
- Preserve the most recent timestamp when merging
- Log consolidation decisions for audit/rollback
- Without careful pruning, memory stores accumulate redundant and outdated information that degrades agent quality

**Amazon Bedrock AgentCore** implements this with a three-step process: extract → consolidate → store, where consolidation uses LLM analysis to merge similar topics and resolve conflicting facts.

---

### 5. Cross-Project Portability

**Confidence: HIGH for symlink patterns and MCP portability; MEDIUM for registry approaches**

#### Sharing Skills Across Projects

**Symlink Pattern** (simplest, most reliable):
```bash
# Central skill repository
~/agent-skills/
  review/SKILL.md
  deploy/SKILL.md
  commit/SKILL.md

# Symlink into each project
ln -s ~/agent-skills/review /path/to/project-a/.claude/skills/review
ln -s ~/agent-skills/deploy /path/to/project-b/.claude/skills/deploy
```

Microsoft's `github.com/microsoft/skills` repository documents this pattern explicitly: "share skills across different agent configs in the same repo using symlinks."

**Personal Skills Directory** (`~/.claude/skills/`):
Skills stored here are available in all projects without symlinks. This is the simplest approach for skills that are truly universal (e.g., commit conventions, code review patterns).

**Plugin Distribution**:
Claude Code plugins can bundle skills in a `skills/` directory. Plugins are shared via git repos and enabled per-project. Plugin skills use namespaced names to avoid conflicts.

**Central Repository Pattern**:
```
~/dev/shared-skills/           # Git repo of skills
  .claude/skills/
    review/SKILL.md
    deploy/SKILL.md
    ...

# Each project adds via --add-dir
claude --add-dir ~/dev/shared-skills
```

Skills from `--add-dir` directories are auto-discovered and support live editing.

**Microsoft's agent-skills repository**: 126 modular knowledge packages organized by domain, plus reusable templates, persona definitions, and pre-configured MCP servers. Demonstrates the central repository pattern at scale.

#### MCP Servers as Portable Tool Layers

An MCP server configured in `~/.claude/settings.json` is available across all projects. This makes MCP the natural portability layer for:

- **Memory**: One MCP memory server shared by all projects, with namespace isolation per project
- **Custom tools**: Business-specific tools (deploy, ticket lookup, etc.) available everywhere
- **External integrations**: APIs, databases, services accessible from any project

**Cross-client compatibility**: The same MCP server works with Claude Code, Cursor, VS Code, JetBrains, and any other MCP-compatible client. This means a memory server built for Claude Code also works if you switch to another agent.

**Mem0 OpenMemory** exemplifies this: a Docker-based MCP memory server (FastAPI + Postgres + Qdrant) that serves persistent memory to any MCP client. Memories are scoped by client and user, with a dashboard for management.

#### Skill Versioning

**Semantic versioning** for skills follows standard semver:
- **MAJOR**: Breaking change to skill behavior or expected output format
- **MINOR**: New capability that doesn't change existing behavior
- **PATCH**: Bug fix or clarification to instructions

ClawHub implements this with semver tags, changelogs, and a `latest` tag.

**Practical versioning for local skills**: Since skills are often in git repos, git history provides implicit versioning. For explicit versioning, add a `version` field to frontmatter (not currently part of the spec but forwards-compatible).

**Update strategy**: When updating a shared skill, test it in one project before propagating. Symlinks make this natural — update the source, and all linked projects get the update simultaneously (which is both the strength and the risk).

---

### 6. Future-Proofing Considerations

**Confidence: HIGH for standards trajectory; MEDIUM for specific timeline predictions**

#### Agent Skills as the Portable Format

The Agent Skills spec (agentskills.io) is the strongest bet for format stability:

- Published December 18, 2025 by Anthropic as an open standard
- Adopted within days by OpenAI (for Codex CLI), Google (Gemini CLI), Microsoft (GitHub Copilot), and 20+ other platforms
- The format is deliberately simple: a folder with markdown and optional scripts
- Cross-platform by design: "A skill you build for Claude works identically in OpenAI Codex, Gemini CLI, GitHub Copilot, Cursor, VS Code, and over 20 other platforms"

**Risk of format changes**: Low for the core format (SKILL.md with YAML frontmatter). Medium for Claude Code-specific extensions (context: fork, agent field, hooks). The core standard is governed by agentskills.io; Claude Code extensions are Anthropic-specific additions that other platforms may or may not adopt.

**Mitigation**: Keep core skill logic in standard SKILL.md format. Use Claude Code extensions (subagents, hooks, allowed-tools) only where needed, and isolate them so the skill degrades gracefully on other platforms.

#### MCP as the Infrastructure Standard

Model Context Protocol has achieved critical mass:

- **Specification maturity**: June 2025 spec established stable foundation; November 2025 spec added significant features
- **Governance**: Donated to the Agentic AI Foundation (AAIF) under the Linux Foundation in December 2025, co-founded by Anthropic, Block, and OpenAI, with support from AWS, Google, Microsoft, and Cloudflare
- **Ecosystem**: Thousands of community MCP servers; 8,600+ listed on PulseMCP
- **Trajectory**: "If 2025 is the year of adoption, 2026 will be the year of expansion"

MCP is the safest portability layer for tools and memory because it is:
1. Vendor-neutral (Linux Foundation governance)
2. Multi-platform (supported by all major AI platforms)
3. Protocol-level (client-agnostic by design)

#### Making Memory Framework-Independent

To make memory independent of any specific agent framework:

1. **Store memory in standard formats**: SQLite databases, JSON, or markdown files that any system can read
2. **Expose via MCP**: Use MCP as the access layer so any agent can read/write memories
3. **Namespace by project and agent**: Isolate memories by scope so they don't leak across contexts
4. **Use standard embeddings**: BGE-M3, OpenAI text-embedding-3-small, or other widely-supported embedding models for vector search
5. **Document the schema**: If using SQLite, the schema itself is the API contract

**Anti-pattern**: Building memory tightly coupled to one agent's internal APIs (e.g., CrewAI's memory classes, LangGraph's memory store). These work well within their framework but lock you in.

#### Standard Formats for Multi-Framework Consumption

| Layer | Standard | Confidence |
|-------|----------|------------|
| **Skill format** | Agent Skills (agentskills.io) | HIGH — adopted by major platforms |
| **Tool protocol** | MCP (modelcontextprotocol.io) | HIGH — Linux Foundation governance |
| **Memory storage** | SQLite + vector extensions | MEDIUM — de facto but not formalized |
| **Memory protocol** | MCP memory tools | MEDIUM — patterns emerging but not standardized |
| **Embedding format** | Float32 vectors + model identifier | HIGH — universal across all vector stores |

The missing standard is a **memory schema specification** — a defined set of tables, fields, and query patterns that multiple frameworks agree on. Mem0/OpenMemory is the closest to this but is still one implementation, not a spec.

---

## Comparison Table

| Dimension | Claude Code Skills | smolagents | LangGraph | CrewAI | OpenClaw | Mem0/OpenMemory |
|-----------|-------------------|------------|-----------|--------|----------|-----------------|
| **Skill/Tool Format** | SKILL.md (markdown) | Python @tool | Python functions | Python classes | SKILL.md + registry | N/A (memory-focused) |
| **Memory Backend** | External (MCP) | None | LangMem + Postgres/pgvector | ChromaDB + SQLite3 | SQLite + sqlite-vec | Postgres + Qdrant |
| **Semantic Search** | Depends on MCP server | N/A | pgvector | ChromaDB | sqlite-vec (70/30 hybrid) | Qdrant |
| **Memory Consolidation** | Manual (session-reflect) | N/A | LangMem dedup | LLM-assisted | Pre-compaction flush | LLM-assisted merge |
| **Cross-Project Sharing** | Symlinks, ~/.claude/skills, plugins | HF Hub | Python packages | Python packages | ClawHub registry | Docker-based MCP server |
| **Portability** | HIGH (open standard) | MEDIUM | MEDIUM | LOW | MEDIUM | HIGH (MCP-based) |
| **Multi-Agent** | Subagents (context: fork) | Multi-agent orchestration | Graph-based state machine | Role-based crews | Single agent | N/A |
| **Security Model** | File permissions + allowlists | Code execution sandbox | Code execution | Code execution | Community moderation + VirusTotal | Local-first + access logs |
| **Maturity** | Production (Dec 2025) | Stable | v1.0 (Oct 2025) | Production | Production (but security incidents) | Production (May 2025) |

---

## Sources

1. [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills)
2. [Anthropic Skills Repository (GitHub)](https://github.com/anthropics/skills)
3. [Skill Authoring Best Practices — Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
4. [Equipping Agents for the Real World with Agent Skills — Anthropic Blog](https://claude.com/blog/equipping-agents-for-the-real-world-with-agent-skills)
5. [Claude Agent Skills: A First Principles Deep Dive — Lee Han Chung](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/)
6. [Inside Claude Code Skills — Mikhail Shilkov](https://mikhail.io/2025/10/claude-code-skills/)
7. [Agent Skills: Anthropic's Next Bid to Define AI Standards — The New Stack](https://thenewstack.io/agent-skills-anthropics-next-bid-to-define-ai-standards/)
8. [MCP, Skills, and Agents — David Cramer](https://cra.mr/mcp-skills-and-agents/)
9. [smolagents Documentation — HuggingFace](https://huggingface.co/docs/smolagents/guided_tour)
10. [smolagents Tools Course — HuggingFace Agents Course](https://huggingface.co/learn/agents-course/en/unit2/smolagents/tools)
11. [LangGraph Agent Orchestration Framework](https://www.langchain.com/langgraph)
12. [LangMem SDK Launch — LangChain Blog](https://blog.langchain.com/langmem-sdk-launch/)
13. [LangChain Memory Overview](https://docs.langchain.com/oss/python/langgraph/memory)
14. [CrewAI Memory Documentation](https://docs.crewai.com/en/concepts/memory)
15. [Deep Dive into CrewAI Memory Systems — SparkCo](https://sparkco.ai/blog/deep-dive-into-crewai-memory-systems)
16. [ClawHub — OpenClaw Documentation](https://docs.openclaw.ai/tools/clawhub)
17. [OpenClaw Memory Documentation](https://docs.openclaw.ai/concepts/memory)
18. [Local-First RAG: Using SQLite for AI Agent Memory with OpenClaw — PingCAP](https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/)
19. [How to Fix OpenClaw's Memory Search with QMD — Jose Casanova](https://www.josecasanova.com/blog/openclaw-qmd-memory)
20. [OpenMemory MCP Server — Mem0](https://mem0.ai/openmemory)
21. [Mem0 OpenMemory Overview](https://docs.mem0.ai/openmemory/overview)
22. [Persistent Memory for AI Agents: Comparing PAG, Memory.md, and SQLite — SparkCo](https://sparkco.ai/blog/persistent-memory-for-ai-agents-comparing-pag-memorymd-and-sqlite-approaches)
23. [AI Agent Memory Management: When Markdown Files Are All You Need — DEV Community](https://dev.to/imaginex/ai-agent-memory-management-when-markdown-files-are-all-you-need-5ekk)
24. [Memori: Open-Source SQL-Native AI Memory Engine](https://www.infoq.com/news/2025/12/memori/)
25. [Vector Database Comparison: Pinecone vs Weaviate vs Qdrant vs FAISS vs Milvus vs Chroma — LiquidMetal AI](https://liquidmetal.ai/casesAndBlogs/vector-comparison/)
26. [Beyond Vector Databases: Architectures for True Long-Term AI Memory — Medium](https://vardhmanandroid2015.medium.com/beyond-vector-databases-architectures-for-true-long-term-ai-memory-0d4629d1a006)
27. [Agentic Memory Systems — Emergent Mind](https://www.emergentmind.com/topics/agentic-memory-systems)
28. [Memory in the Age of AI Agents — arXiv](https://arxiv.org/abs/2512.13564)
29. [Memory Strategies — Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-strategies.html)
30. [Memory for AI Agents: A New Paradigm of Context Engineering — The New Stack](https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/)
31. [MemOS: A Memory OS for AI System — arXiv](https://arxiv.org/pdf/2507.03724)
32. [MCP Specification (November 2025)](https://modelcontextprotocol.io/specification/2025-11-25)
33. [A Year of MCP: From Internal Experiment to Industry Standard — Pento](https://www.pento.ai/blog/a-year-of-mcp-2025-review)
34. [Model Context Protocol — Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)
35. [Microsoft Agent Skills Repository](https://github.com/microsoft/skills)
36. [OpenAI Codex Skills Documentation](https://developers.openai.com/codex/skills/)
37. [OpenAI Skills Repository (GitHub)](https://github.com/openai/skills)
38. [Agent Skills Open Standard — agentskills.io (via Simon Willison)](https://simonwillison.net/2025/Dec/19/agent-skills/)
39. [Comparing Open-Source AI Agent Frameworks — Langfuse Blog](https://langfuse.com/blog/2025-03-19-ai-agent-comparison)
40. [Top 7 Agentic AI Frameworks in 2026 — AlphaMatch](https://www.alphamatch.ai/blog/top-agentic-ai-frameworks-2026)

---

## Implications

### Recommended Evolution Path for Our Current Setup

Our current setup: Claude Code + `.claude/skills/` + FastMCP memory server + CLAUDE.md files.

#### Immediate (Low Effort, High Impact)

1. **Use `~/.claude/skills/` for universal skills**: Move skills that apply to all projects (session-reflect, skill-creator, debug-skills) to the personal skills directory. They are already there based on the current state.

2. **Add structured metadata to memory entries**: Even within the existing markdown-based MCP memory server, start including structured YAML frontmatter in memory entries (timestamp, category, importance, access_count). This prepares for migration to a richer backend.

3. **Implement memory consolidation**: Add a `memory_consolidate` tool to the MCP server that uses LLM-assisted deduplication — retrieve top-K similar memories for each new entry, merge if semantically equivalent.

#### Medium-Term (Moderate Effort, Significant Impact)

4. **Migrate memory backend to SQLite**: Replace pure markdown storage with SQLite + sqlite-vec. Keep markdown as a human-readable export format, but use SQLite as the primary store. Schema should include: id, content, embedding, category, importance, created_at, updated_at, access_count, namespace.

5. **Implement hybrid search**: 70% vector similarity + 30% BM25 keyword search, following the OpenClaw pattern. This significantly improves recall over keyword-only or vector-only approaches.

6. **Add relevance decay scoring**: Score memories using a composite of semantic similarity, recency (exponential decay), importance, and access frequency. Use this for retrieval ranking and to identify pruning candidates.

7. **Create a central skills repository**: Set up a git repo (e.g., `~/dev/shared-skills/`) with skills organized by domain. Symlink or use `--add-dir` to share across projects.

#### Long-Term (Higher Effort, Strategic Impact)

8. **Automated skill graduation**: Track corrections and recurring patterns in memory. When a pattern appears 3+ times, automatically flag it for skill creation. Use the skill-creator skill to convert it.

9. **Cross-project memory namespacing**: Extend the MCP memory server to support namespaces (per-project + global). Global memories (tool preferences, coding style) are shared; project memories (architecture decisions, API patterns) stay scoped.

10. **Memory versioning and audit trail**: Log every memory mutation with timestamp, operation type, and previous value. Enable rollback for contaminated or hallucinated memories.

---

## Open Questions

1. **Embedding model choice**: Which embedding model should we use for the SQLite-vec backend? BGE-M3 offers good multilingual performance but is heavier. Local models (via Ollama) would keep everything local-first. Need to benchmark latency vs quality tradeoff for our typical memory sizes.

2. **Memory consolidation trigger**: Should consolidation run on every write (more consistent but slower), on a schedule (simpler but might miss duplicates), or on a threshold (e.g., every 50 new memories)? OpenClaw uses a "pre-compaction flush" before context overflow — worth testing.

3. **Skill security model**: ClawHub's February 2026 security incident (341 malicious skills) raises questions about community skill registries. How do we safely consume third-party skills? Options: manual review, sandboxed execution, allowlisted sources only.

4. **Memory schema standardization**: No standard memory schema exists across frameworks. Should we align with Mem0's schema (most widely deployed), OpenClaw's (most transparent implementation), or design our own? The first framework to publish a memory schema spec could set the standard.

5. **Context budget optimization**: With many skills, we may hit the 2% context window budget for skill descriptions. Need to measure actual description sizes and potentially implement tiered loading (most-used skills get priority).

6. **MCP memory server performance**: At what memory count does the current markdown-based MCP server become a bottleneck? Need to benchmark read/write latencies at 100, 1,000, and 10,000 memories to understand the migration urgency to SQLite.

7. **Multi-agent memory coordination**: If we use subagents (context: fork) for tasks like /batch, how should forked agents' discoveries feed back into the main memory store? LangGraph solves this with cross-thread memory; we need an equivalent pattern.

8. **Skill format forward compatibility**: The Agent Skills spec is new (December 2025). How stable is it really? Should we add an abstraction layer between our skills and the spec, or is the format simple enough that direct adoption is safe?
