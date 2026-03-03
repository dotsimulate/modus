# Master Research Summary — Lightweight Agent Harness
*Generated: 2026-03-02*
*Based on 6 parallel research reports totaling ~3,500 lines*

---

## Executive Summary

We researched the full stack for building a modular, self-optimizing agent backend on top of Claude Code. The findings are clear enough to make concrete architectural decisions.

**The single most important finding**: Both the CLI and the Agent SDK support Pro/Max subscription billing. The SDK uses the same auth as the CLI — run `claude setup-token` to get an OAuth token, set `CLAUDE_CODE_OAUTH_TOKEN`, and the SDK bills against your subscription quota. The official docs emphasize API keys, but OAuth token auth works for first-party/personal use. This means **the Agent SDK is the right choice for our harness** — we get typed events, in-process hooks, programmatic session management, AND subscription billing.

**The second most important finding**: Claude Code already has native support for almost everything we need — agent profiles (`.claude/agents/*.md` + `--agent` flag), tool restriction (`--tools`, `--allowedTools`, `--disallowedTools` with glob patterns), per-session MCP server attachment (`--mcp-config` + `--strict-mcp-config`), streaming JSON output (`--output-format stream-json`), session resumption (`--resume`), and headless operation (`-p`). We don't need to build much of this from scratch.

**The third most important finding**: The skills format (SKILL.md) is now an open standard adopted by OpenAI, Google, Microsoft, and 20+ platforms. Our existing `.claude/skills/` setup is on the right track. Memory is the area that needs the most work — moving from markdown files to SQLite + vector extensions would significantly improve recall and scalability.

---

## Recommended Starting Architecture

```
                    ┌──────────────────────────────┐
                    │     Agent Profile Store       │
                    │  ~/.claude/agents/*.md        │
                    │  + per-profile MCP configs    │
                    └──────────────┬───────────────┘
                                   │
┌─────────┐    ┌───────────────────▼───────────────────┐
│ Frontend │◄──►│         FastAPI Harness Server        │
│ (later)  │SSE │  - Profile selection                  │
└─────────┘    │  - Session management (create/resume) │
                │  - Streaming bridge (events → SSE)    │
                │  - Concurrent session tracking        │
                └───────────────────┬───────────────────┘
                                    │ async iterator
                    ┌───────────────▼───────────────┐
                    │   Claude Agent SDK (Python)    │
                    │  query(prompt, options=...)     │
                    │  - OAuth token auth (sub billing│
                    │  - In-process hooks             │
                    │  - Typed streaming events       │
                    │  - Session resume/fork          │
                    └───────────────┬───────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │        LiteLLM Proxy           │
                    │    (http://localhost:4000)      │
                    ├───────────┬───────────────────┤
                    │  Claude   │  llama.cpp (local) │
                    │  (cloud)  │  (via OpenAI API)  │
                    └───────────┴───────────────────┘
```

### Why Agent SDK (Not CLI Subprocess)

The SDK wraps the CLI internally but gives us significantly more control:

| Factor | CLI Subprocess | Agent SDK |
|--------|---------------|-----------|
| **Subscription billing** | Native | Via OAuth token (`claude setup-token`) |
| **Streaming** | NDJSON stdout parsing | Typed async iterators |
| **Hooks** | Shell command hooks | In-process callbacks (PreToolUse, PostToolUse, etc.) |
| **Custom tools** | MCP servers only | `@tool` decorator (in-process, no IPC) |
| **Session management** | --resume/--continue flags | Programmatic resume/fork with session IDs |
| **Concurrency** | Process management | Multiple `query()` calls in one process |
| **Error handling** | Exit codes + stderr | Structured `ResultMessage` with error types |

**Auth setup**: `claude setup-token` → browser auth → set `CLAUDE_CODE_OAUTH_TOKEN` → SDK uses subscription quota.

### Why FastAPI

- Python ecosystem aligns with our tools (litellm, llama.cpp bindings, existing scripts)
- Native async support for concurrent sessions
- SSE support for streaming responses
- `claude-code-openai-wrapper` validates this pattern (FastAPI + Agent SDK, 500+ GitHub stars)
- Easy to add REST endpoints for session management

---

## Key Findings by Topic

### 1. CLI vs SDK (Report 01)

**CLI strengths for our use case:**
- Subscription billing (Pro/Max) — no per-token costs
- `--output-format stream-json` gives NDJSON with all events
- `--agent` flag loads agent profiles natively
- `--max-turns`, `--max-budget-usd` for safety limits
- `--resume` / `--continue` for session persistence
- Mature, fewer bugs than SDK

**SDK advantages we're deferring:**
- In-process hooks (PreToolUse, PostToolUse with typed callbacks)
- Custom tools via `@tool` decorator
- Session forking programmatically
- Container-based hosting patterns
- 18 hook event types in TypeScript (10 in Python)

**Billing**: The SDK supports subscription billing via OAuth token. Run `claude setup-token`, set `CLAUDE_CODE_OAUTH_TOKEN`, and the SDK uses your Pro/Max quota. The official docs push API keys, but OAuth auth works for first-party use. This was confirmed by the `claude_agent_sdk_oauth_demo` project and community reports.

### 2. Agent Profiles (Report 02)

**Already built into Claude Code — we just need to use it:**

```markdown
# .claude/agents/research-agent.md
---
name: research-agent
description: Research agent with web search and read-only access
tools: Read, Glob, Grep, WebSearch, WebFetch
disallowedTools: Write, Edit, Bash
model: sonnet
permissionMode: plan
---

You are a research assistant. Search the web and read code to answer
questions. Never modify files.
```

Invoke: `claude --agent research-agent`

**Key mechanisms:**
- `--tools` restricts available tools (others don't exist)
- `--allowedTools` auto-approves listed tools (others still prompt)
- `--disallowedTools` removes tools from model context entirely
- `--strict-mcp-config` + `--mcp-config` isolates MCP servers per profile
- `CLAUDE_CONFIG_DIR` provides complete config isolation
- `CLAUDE_CODE_SIMPLE=1` strips down to Bash/Read/Edit only (no MCP, no hooks, no CLAUDE.md)
- Tool name patterns support globs: `Bash(git *)`, `mcp__servername__*`
- Deny always wins over allow, regardless of scope

**Profile switching**: Shell aliases wrapping `claude --agent <name>` with appropriate flags.

### 3. Harness Architecture (Report 03)

**Recommended: CLI subprocess with persistent stream-JSON connection:**

```bash
# Persistent session — loads system prompt once, sends subsequent messages via stdin
claude --print --input-format stream-json --output-format stream-json --session-id <id>
```

This avoids the ~50K token overhead of spawning fresh processes per interaction. The "4-layer isolation technique" further reduces this to ~5K tokens per subprocess turn:

1. Scoped working directory (not home)
2. Git boundary (`.git/HEAD` in workspace)
3. Empty plugin directory
4. `--setting-sources project,local` (exclude user-level settings)

**Existing open-source references:**
| Project | Approach | Stars | Stack |
|---------|----------|-------|-------|
| `claude-agent-server` | SDK + WebSocket | 526 | Bun/TS + E2B |
| `claude-code-openai-wrapper` | SDK + REST/SSE | — | Python/FastAPI |
| `claude-code-webui` | CLI subprocess + React | — | Deno + React |
| `opcode` | Desktop GUI | — | Tauri (Rust + React) |
| `cc-connect` | Bridge to messaging | — | Go |

**Session persistence**: Sessions stored in `~/.claude/projects/<path-hash>/<session-id>/` as append-only JSONL. Survives crashes (mostly — known bug #27463 where directory isn't always created).

### 4. Multi-Model Routing (Report 04)

**LiteLLM is the right proxy layer — we already have it:**

Three routing mechanisms, progressively more sophisticated:

1. **Manual model selection**: `claude --model local-llama` routes through LiteLLM to local llama.cpp
2. **MCP tool delegation**: An MCP server wraps llama.cpp, Claude calls it as a tool for summarization/classification
3. **Auto-routing**: LiteLLM's complexity router scores requests and routes SIMPLE/MEDIUM to local, COMPLEX/REASONING to Claude

**MCP-based delegation pattern** (highest leverage for our setup):
- Deploy `llama-mcp-server` or custom FastMCP server wrapping local model
- Claude decides when to delegate: "summarize this with local model" → MCP tool call
- Claude retains reasoning control, offloads bulk processing

**Task routing heuristic:**
- Claude: complex reasoning, code generation, architecture, security review
- Local 7-13B: summarization, classification, extraction, boilerplate, embeddings
- Community reports: 70% of routine tasks can run locally at 80% lower cost

**Subscription billing through LiteLLM**: OAuth forwarding preserves subscription billing when routing through proxy.

### 5. Scheduled/Proactive Agents (Report 05)

**Start with systemd timers — the thinnest possible layer:**

```ini
# ~/.config/systemd/user/claude-morning.timer
[Timer]
OnCalendar=Mon..Fri *-*-* 08:00:00
Persistent=true
```

Calls a shell script that runs `claude -p "..." --max-turns 10 --allowedTools "Bash(gh *),Read" --output-format json`.

**Progression path:**
1. **Day 1**: systemd timer + shell script (GitHub notification summary)
2. **Week 2-3**: Add event-driven triggers (file watcher, git hooks, webhook receiver)
3. **Week 4+**: Heartbeat loop with `HEARTBEAT.md` checklist (OpenClaw pattern)
4. **Only if needed**: n8n for multi-service orchestration

**OpenClaw heartbeat pattern**: Agent wakes every N minutes, reads a checklist, decides if action is needed. Suppresses notifications when nothing to report. Active hours prevent 3 AM runs. This is the most mature proactive agent pattern available.

**Safety rails for unattended execution:**
- `--max-turns 10` (prevent runaway loops)
- `--allowedTools "Read,Bash(gh *)"` (restrict tool surface)
- Container isolation if using `--dangerously-skip-permissions`
- systemd `TimeoutStartSec=600` + `OnFailure=` notification
- JSON output logging for audit trail

### 6. Portable Skills & Memory (Report 06)

**Skills are in great shape — SKILL.md is now an open standard:**
- Published by Anthropic (Dec 2025), adopted by OpenAI, Google, Microsoft, 20+ platforms
- Our `.claude/skills/` setup is standard-compliant
- Cross-project sharing: `~/.claude/skills/` (personal) or symlinks from a central repo
- `--add-dir ~/dev/shared-skills` for skill discovery from external directories

**Memory needs the most work:**
- Current markdown-based MCP memory server will hit scaling walls (no semantic search, linear lookup)
- Best upgrade path: SQLite + sqlite-vec extension
  - Single file, zero config, ACID-compliant
  - Vector similarity search + FTS5 keyword search
  - Hybrid scoring: 70% vector + 30% BM25 → 89% recall (vs 76% vector-only)
- Memory management patterns needed:
  - LLM-assisted deduplication on write
  - Relevance decay scoring (semantic similarity × recency × importance × access frequency)
  - Epochal summarization for old memories (compress N entries → 1 summary)
  - Skill graduation: pattern seen 3+ times → flag for SKILL.md creation

**ClawHub security incident (Feb 2026)**: 341 malicious skills discovered in OpenClaw's community registry. Lesson: never auto-execute third-party skills without review. Our approach (local skills only, manual creation) is safer.

---

## Highest-Leverage Next Steps

### Phase 1 — Foundation (This Week)

1. **Create agent profile files** in `.claude/agents/`:
   - `research-agent.md` — read-only, web search, no bash
   - `coding-agent.md` — full tools, acceptEdits mode
   - `review-agent.md` — read + grep only, plan mode
   - `ops-agent.md` — bash + specific MCP tools

2. **Create per-profile MCP configs** in `~/.claude/`:
   - `mcp-research.json` (web search MCP servers)
   - `mcp-base.json` (memory server only)
   - One config per profile, used with `--strict-mcp-config`

3. **Create shell aliases** for profile switching:
   ```bash
   alias cr='claude --agent research-agent --strict-mcp-config --mcp-config ~/.claude/mcp-research.json'
   alias cc='claude --agent coding-agent'
   ```

4. **Set up first systemd timer** — morning GitHub notification summary

### Phase 2 — Harness (Next 2 Weeks)

5. **Build minimal FastAPI harness** wrapping Claude Agent SDK (Python):
   - Auth: `claude setup-token` → set `CLAUDE_CODE_OAUTH_TOKEN` → subscription billing
   - `POST /sessions` — create session with profile selection
   - `POST /sessions/{id}/messages` — send message, SSE streaming response
   - `GET /sessions` — list active sessions
   - Use SDK's async iterator for streaming, in-process hooks for logging/control

6. **Configure LiteLLM proxy** with Claude (subscription forwarding) + local llama.cpp

7. **Build MCP tool for local model delegation** — simple FastMCP server wrapping llama.cpp for summarization/classification

### Phase 3 — Memory & Intelligence (Weeks 3-4)

8. **Upgrade memory server to SQLite + sqlite-vec**:
   - Hybrid search (70% vector + 30% BM25)
   - Structured metadata (timestamps, categories, importance, access count)
   - Relevance decay scoring
   - LLM-assisted deduplication on write

9. **Implement heartbeat pattern** — Python loop with HEARTBEAT.md checklist, active hours, backoff

10. **Set up central skills repo** — `~/dev/shared-skills/` with symlinks to projects

---

## Contradictions and Uncertainties

### Contradictions Between Reports

1. **SDK billing**: Report 01 stated the SDK requires API key billing only. **Correction**: The SDK supports subscription billing via OAuth token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`). The SDK wraps the CLI, so it uses whatever auth the CLI has. This aligns Report 01 and 03 — the SDK + FastAPI recommendation stands without billing constraints.

2. **Token cost concerns vs subscription billing**: Multiple reports discuss token cost optimization (4-layer isolation, complexity routing). On subscription billing, token cost is irrelevant — but **usage quota consumption** still matters. Each turn may count as a "message" against the rolling limit. **Needs testing**: How many messages does a 10-turn SDK session consume?

3. **`allowed_tools` reliability**: Report 02 notes open GitHub issues about `allowed_tools` not reliably restricting tools in the SDK. The CLI flags (`--tools`, `--disallowedTools`) appear more reliable. **Resolution**: Use `disallowed_tools` (remove from context) as primary restriction in the SDK, with PreToolUse hooks as backup.

### Information Gaps Needing Hands-On Testing

| Question | Why It Matters | How to Test |
|----------|---------------|-------------|
| SDK OAuth token quota tracking — does it show in subscription dashboard? | Need visibility into quota consumption | Run SDK sessions with OAuth, check claude.ai usage stats |
| How many "messages" does a multi-turn `claude -p` session consume? | Affects scheduling frequency decisions | Run sessions, check usage dashboard |
| Does `--strict-mcp-config` block subagent-level `mcpServers`? | Affects profile isolation | Create agent with mcpServers, invoke with --strict-mcp-config |
| Session storage directory creation bug (#27463) — still present? | Affects crash recovery reliability | Kill processes during execution, check for session data |
| Does `--agent` + `--tools` compose or conflict? | Affects profile definition strategy | Test agent file with tools field + CLI --tools flag |
| What is the persistent stream-JSON connection's memory footprint over 24h? | Affects long-running harness design | Run a session for 24h, monitor RSS |
| LiteLLM complexity router accuracy for code tasks | Affects auto-routing viability | Route 100 diverse tasks, check routing decisions |
| Quota consumption rate for heartbeat-style sessions | Affects scheduling frequency | Run hourly heartbeats for a week, measure quota impact |

### Stale or Uncertain Information

- **OpenClaw details**: Some implementation details may be specific to their latest version; their docs move fast
- **Claude Cowork scheduled tasks**: Very new (Feb 2026), limited community reports on reliability
- **Agent Skills standard adoption**: Claimed "20+ platforms" but actual implementation depth varies; some may support only basic SKILL.md format without extensions
- **ClawHub security incident**: Timeline and scope confirmed, but remediation completeness unclear
- **Agent Teams**: Experimental, disabled by default, known limitations — don't build on this yet

---

## Report Inventory

| File | Lines | Topic | Quality |
|------|-------|-------|---------|
| `01_cli_vs_sdk.md` | 365 | CLI vs Agent SDK comparison | Excellent — comprehensive, well-sourced |
| `02_agent_profiles.md` | 696 | Agent profiles and tool config | Excellent — actionable patterns with code |
| `03_harness_architectures.md` | 682 | Backend harness architectures | Excellent — 8 OSS projects profiled |
| `04_multi_model_routing.md` | 643 | Multi-model routing with LiteLLM | Excellent — phased implementation plan |
| `05_scheduled_agents.md` | 911 | Proactive/scheduled agent patterns | Excellent — working code examples throughout |
| `06_portable_skills_memory.md` | 621 | Portable skills and memory systems | Excellent — strong comparison across frameworks |

All 6 subagents completed successfully. No failures.

---

*Total research tokens consumed: ~395K across 6 agents*
*Total research time: ~6 minutes (parallel execution)*
