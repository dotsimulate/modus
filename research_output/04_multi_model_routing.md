# Multi-Model Routing with Claude Code -- Research Report
*Generated: 2026-03-02*

## Summary

Multi-model routing -- using Claude Code alongside local models like llama.cpp through a unified proxy -- is now a well-supported, practical workflow in the 2025-2026 ecosystem. LiteLLM has emerged as the dominant proxy layer, offering protocol translation, load balancing, fallback chains, and even automatic complexity-based routing that can send simple tasks to cheap/local models and complex tasks to Claude. The key architectural insight is that Claude Code can be configured to talk to a LiteLLM proxy (via `ANTHROPIC_BASE_URL`), which then routes to any backend -- including local llama.cpp endpoints -- while preserving subscription billing through OAuth token forwarding.

Three practical routing mechanisms exist today: (1) LiteLLM as a transparent proxy with fallback/routing rules, (2) MCP tool servers that wrap local model inference and expose it as tools Claude can call, and (3) CCS-Delegation and similar skill-based systems that analyze task keywords and route to the optimal model. For a user running Claude Code on a subscription plan with llama.cpp and Open WebUI already available on Fedora, the recommended approach is a LiteLLM proxy that unifies Claude (via subscription forwarding) with local llama.cpp endpoints, combined with MCP tools for targeted local-model delegation from within Claude Code sessions.

The ecosystem is moving fast. Agent teams (experimental in Claude Code), multi-provider orchestration frameworks like Ruflo, and LiteLLM's complexity router all point toward a future where model routing is automatic and task-aware. The infrastructure is ready today for a manual or semi-automated hybrid workflow; fully automatic routing based on task complexity is available but still maturing.

---

## Findings

### 1. LiteLLM as Unified Proxy

**Confidence: HIGH** -- LiteLLM is well-documented, actively maintained, and has first-party integration guidance from both Anthropic and the LiteLLM team.

#### What LiteLLM Does

LiteLLM is a Python SDK and proxy server (self-described as an "AI Gateway") that provides a unified API across 100+ LLM providers. It receives requests in one format (e.g., Anthropic Messages API), translates them to the target provider's format, forwards the request, and translates the response back. This means Claude Code can talk to OpenAI, Gemini, local Ollama, llama.cpp, or any OpenAI-compatible endpoint through a single proxy.

#### Configuring Claude + Local llama.cpp

The proxy is configured via a YAML `config.yaml` file with a `model_list`:

```yaml
model_list:
  # Claude via Anthropic (subscription forwarding)
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      api_key: os.environ/ANTHROPIC_API_KEY

  # Local llama.cpp endpoint
  - model_name: local-llama
    litellm_params:
      model: openai/local-model       # openai/ prefix for OpenAI-compatible endpoints
      api_base: http://localhost:8080/v1
      api_key: "not-needed"            # llama.cpp doesn't require auth

  # Ollama-hosted model (alternative)
  - model_name: local-codellama
    litellm_params:
      model: ollama/codellama
      api_base: http://localhost:11434

general_settings:
  master_key: sk-your-master-key

router_settings:
  routing_strategy: simple-shuffle     # or latency-based-routing, cost-based-routing
```

Start the proxy:
```bash
pip install 'litellm[proxy]'
litellm --config /path/to/config.yaml
# Proxy runs on http://0.0.0.0:4000
```

#### Routing Capabilities

LiteLLM supports several routing strategies:

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `simple-shuffle` | Random distribution across deployments (default) | General load balancing |
| `least-busy` | Routes to deployment with fewest active requests | Avoiding overload |
| `latency-based-routing` | Routes to fastest-responding deployment | Latency-sensitive tasks |
| `cost-based-routing` | Routes to cheapest deployment | Cost optimization |
| `usage-based-routing` | Routes to deployment with lowest current usage | Even distribution (requires Redis) |

**Fallback chains** are configured as:
```yaml
router_settings:
  fallbacks:
    - claude-sonnet: [local-llama]   # If Claude fails, fall back to local
  context_window_fallbacks:
    - claude-sonnet: [local-llama]   # If context too long, use local
  allowed_fails: 3                    # Cooldown after 3 failures/minute
  cooldown_time: 60                   # Seconds to cooldown
```

**Deployment ordering** allows priority-based routing:
```yaml
model_list:
  - model_name: my-model
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      order: 1    # Primary (lower = higher priority)
  - model_name: my-model
    litellm_params:
      model: openai/local-model
      api_base: http://localhost:8080/v1
      order: 2    # Fallback
```

#### Auto Routing / Complexity Router

LiteLLM includes a **complexity router** that classifies requests into tiers with zero external API calls and sub-millisecond latency:

```yaml
model_list:
  - model_name: smart-router
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: local-llama          # Simple queries -> local model
          MEDIUM: local-llama          # Medium tasks -> local model
          COMPLEX: claude-sonnet       # Complex tasks -> Claude
          REASONING: claude-sonnet     # Reasoning tasks -> Claude
        tier_boundaries:
          simple_medium: 0.15
          medium_complex: 0.35
          complex_reasoning: 0.60
        dimension_weights:
          token_count: 0.10
          code_presence: 0.30
          reasoning_markers: 0.25
          technical_terms: 0.25
          simple_indicators: 0.05
          multi_step_patterns: 0.03
          question_complexity: 0.02
```

This scores each request across seven dimensions and routes accordingly. When two or more reasoning markers appear, requests automatically escalate to the REASONING tier.

#### Subscription Billing Through LiteLLM

For Claude Code Max subscription users, LiteLLM can forward OAuth tokens:

```yaml
general_settings:
  forward_client_headers_to_llm_api: true
  master_key: sk-your-gateway-key
```

Claude Code environment:
```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_MODEL=claude-sonnet
export ANTHROPIC_CUSTOM_HEADERS="x-litellm-api-key: Bearer sk-your-gateway-key"
```

This preserves subscription billing -- LiteLLM tracks usage metrics while Anthropic handles billing through the subscription.

---

### 2. Claude Code <-> Local Model Handoff

**Confidence: MEDIUM-HIGH** -- Multiple working patterns exist, but the "best" approach depends on use case. Some patterns are well-documented, others are community-driven.

#### Pattern A: LiteLLM Proxy (Transparent Routing)

Claude Code connects to LiteLLM, which routes to different backends. Claude Code doesn't "know" it's talking to a local model -- the proxy handles translation transparently.

```bash
# Point Claude Code at LiteLLM
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_AUTH_TOKEN=sk-your-litellm-key

# Use a specific model
claude --model local-llama
```

This is the simplest approach but doesn't allow Claude to *selectively* delegate to local models within a session.

#### Pattern B: MCP Tool That Calls a Local Model

An MCP server can wrap a local llama.cpp endpoint and expose it as a tool that Claude can call:

```json
// claude_desktop_config.json or .claude/settings.json
{
  "mcpServers": {
    "local-llm": {
      "command": "node",
      "args": ["/path/to/llama-mcp-server/build/index.js"],
      "env": {
        "LLAMA_SERVER_URL": "http://localhost:8080"
      }
    }
  }
}
```

The MCP server exposes tools like:
- `chat` -- send a prompt to the local model, get a response
- `summarize` -- summarize text using the local model
- `classify` -- classify text using the local model
- `health_check` -- verify the local model is running

Existing implementations:
- **openconstruct/llama-mcp-server** (Node.js/TypeScript) -- bridges Claude Desktop to llama-server
- **kbrisso/byte-vision-mcp** (Go) -- privacy-first MCP server for llama.cpp

This enables the pattern: "Claude reasons about the task, then calls a tool to have the local model do bulk processing."

#### Pattern C: Bash Tool to Call Local Model API

Within a Claude Code session, Claude can use the Bash tool to call a local model's API directly:

```bash
# Claude can execute this within a session
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "local-model", "messages": [{"role": "user", "content": "Summarize this text: ..."}]}' \
  | jq -r '.choices[0].message.content'
```

This is ad-hoc but effective for one-off delegations. Claude maintains reasoning control while offloading specific operations.

#### Pattern D: CCS-Delegation Skill

CCS (Claude Code Switch) Delegation is a Claude Code skill that analyzes input for keywords related to reasoning, context length, or cost-sensitivity and automatically selects the optimal model profile:

- Analyzes task complexity via keyword matching
- Routes to profiles: Claude Pro for planning, GLM for cost-optimized execution, Ollama for offline/privacy, Gemini for review
- Reports cost (USD), duration, and session IDs
- Community reports indicate 70% of tasks can go to cheaper models at 80% lower cost

#### Pattern E: Subagents and Agent Teams

Claude Code's subagent system spawns separate Claude instances for focused tasks. While subagents currently use the same model as the parent, the experimental **agent teams** feature allows specifying different models per teammate:

```
Create a team with 4 teammates to refactor these modules in parallel.
Use Sonnet for each teammate.
```

Agent teams are experimental (requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) but represent the future direction for multi-model delegation within Claude Code.

---

### 3. Task Routing Patterns

**Confidence: HIGH** -- These patterns are well-established across the industry and confirmed by multiple sources.

#### Tasks Best Suited for Claude (Cloud)

| Task Type | Why Claude | Examples |
|-----------|-----------|----------|
| Complex reasoning | Superior chain-of-thought, handles ambiguity | Architecture decisions, debugging competing hypotheses |
| Code generation | Deep understanding of codebases, context | Writing new features, refactoring with understanding |
| Multi-step planning | Maintains coherent plans across steps | Project decomposition, dependency analysis |
| Code review | Nuanced judgment about quality, security | Security audits, performance reviews |
| Agentic workflows | Tool use, file editing, terminal commands | Full development workflows in Claude Code |
| Novel problem solving | Creative solutions to unfamiliar problems | Designing new APIs, solving edge cases |

#### Tasks Suitable for Local Models

| Task Type | Why Local | Model Recommendations |
|-----------|----------|----------------------|
| Summarization | Well-handled by 7-13B models | Mistral 7B, Llama 3.x 8B |
| Classification | Pattern matching, fast inference | Smaller quantized models (Q4_K_M) |
| Text extraction | Structured extraction is straightforward | Any instruct model |
| Boilerplate generation | Repetitive, template-based | CodeLlama, Qwen Coder |
| Embedding generation | Dedicated embedding models | nomic-embed, all-MiniLM |
| Simple Q&A | Basic factual responses | Phi-3, Gemma 2 |
| Linting / formatting | Rule-based, low reasoning needed | Small models or non-LLM tools |
| Bulk text processing | Volume over quality | Smallest viable model |

#### Decision Framework

```
                    ┌─────────────────────┐
                    │   Incoming Task      │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Requires complex   │──── YES ──→ Claude
                    │  reasoning?         │
                    └──────────┬──────────┘
                               │ NO
                    ┌──────────▼──────────┐
                    │  Requires code      │──── YES ──→ Claude (or large local
                    │  generation?        │            model if available)
                    └──────────┬──────────┘
                               │ NO
                    ┌──────────▼──────────┐
                    │  Batch/bulk         │──── YES ──→ Local model
                    │  processing?        │
                    └──────────┬──────────┘
                               │ NO
                    ┌──────────▼──────────┐
                    │  Privacy-sensitive?  │──── YES ──→ Local model
                    └──────────┬──────────┘
                               │ NO
                    ┌──────────▼──────────┐
                    │  Latency-critical?  │──── YES ──→ Local model (no network)
                    └──────────┬──────────┘
                               │ NO
                    ┌──────────▼──────────┐
                    │  Simple/routine?    │──── YES ──→ Local model
                    └──────────┬──────────┘
                               │ NO
                               ▼
                          Claude (default)
```

#### Cost-Quality-Latency Tradeoffs

| Factor | Claude (Cloud) | Local 7B Model | Local 13B+ Model |
|--------|---------------|----------------|-------------------|
| Quality (reasoning) | Excellent | Limited | Good |
| Quality (code) | Excellent | Moderate | Good |
| Latency (first token) | 500ms-2s | 10-50ms | 20-100ms |
| Throughput | Rate-limited | GPU-bound (fast) | GPU-bound (slower) |
| Cost | Subscription or per-token | Electricity only | Electricity only |
| Privacy | Cloud-processed | Fully local | Fully local |
| Context window | 200K tokens | Model-dependent | Model-dependent |
| Availability | Internet required | Always available | Always available |

---

### 4. MCP as Routing Layer

**Confidence: MEDIUM** -- The concept is sound and implementations exist, but this is still an emerging pattern. No single "standard" MCP router has emerged.

#### Concept: MCP Server as Model Router

An MCP server can act as a routing layer by:
1. Receiving tool calls from Claude Code
2. Analyzing the request to determine optimal backend
3. Dispatching to the appropriate model (local or cloud)
4. Returning results through MCP protocol

#### Architecture

```
Claude Code Session
    │
    ├─ MCP Tool: "summarize" ──→ MCP Router Server ──→ Local llama.cpp
    ├─ MCP Tool: "classify"  ──→ MCP Router Server ──→ Local llama.cpp
    ├─ MCP Tool: "analyze"   ──→ MCP Router Server ──→ Claude API
    └─ MCP Tool: "embed"     ──→ MCP Router Server ──→ Local embedding model
```

#### Existing Implementations

**openconstruct/llama-mcp-server** (TypeScript/Node.js):
- Flow: Claude Desktop <-> MCP Server <-> llama-server API <-> Local Model
- Tools exposed: `chat`, `quick_test`, `health_check`
- Configurable via `LLAMA_SERVER_URL` environment variable
- Parameters: temperature, max_tokens, top_p, top_k, system_prompt

**roryp/mcpsampling** (Java/Spring AI):
- Demonstrates MCP sampling -- servers request LLM completions from clients
- Routes requests to different providers (OpenAI, Ollama) based on model hints
- Uses `@McpSampling` annotations for handler routing
- Can generate content from multiple providers and synthesize results

**kbrisso/byte-vision-mcp** (Go):
- Privacy-first MCP server for llama.cpp
- Exposes a single tool for text completion
- Designed for fully local, air-gapped inference

#### Building a Custom MCP Router

A custom MCP router for your setup could be implemented as a Node.js or Python MCP server that:

1. Defines model-agnostic tools (e.g., `process_text`, `generate_code`, `summarize`)
2. Includes routing logic based on task type, input length, or explicit hints
3. Calls either the local llama.cpp API or a cloud API based on the routing decision
4. Returns results in MCP format

This approach lets Claude "decide" when to use a local model by calling the appropriate tool, while the MCP server handles the actual inference routing.

#### MCP Sampling as a Routing Mechanism

MCP's sampling feature allows servers to request LLM completions from the client during tool execution. This creates a bidirectional pattern where:
- The tool server can ask the host (Claude) for additional reasoning
- The tool server can route its own sub-queries to different models based on hints
- Multiple providers can be queried in parallel and results synthesized

---

### 5. Open WebUI Integration

**Confidence: HIGH** -- Open WebUI + LiteLLM is a well-documented, popular combination with active community support.

#### Architecture

```
                    ┌─────────────────────────────────────┐
                    │            LiteLLM Proxy             │
                    │         (http://localhost:4000)       │
                    ├─────────────┬─────────────┬──────────┤
                    │  Claude API │  llama.cpp  │  Ollama  │
                    │  (cloud)    │  (local)    │  (local) │
                    └──────┬──────┴──────┬──────┴────┬─────┘
                           │             │           │
          ┌────────────────┴─────────────┴───────────┴──────┐
          │                                                  │
    ┌─────┴─────┐                                    ┌──────┴──────┐
    │ Open WebUI│                                    │ Claude Code │
    │ (browser) │                                    │   (CLI)     │
    └───────────┘                                    └─────────────┘
```

#### Setup

Open WebUI connects to LiteLLM as if it were an OpenAI endpoint:

```yaml
# docker-compose.yml
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    ports:
      - "3000:8080"
    environment:
      - OPENAI_API_BASE_URL=http://litellm:4000/v1
      - OPENAI_API_KEY=sk-your-litellm-key

  litellm:
    image: ghcr.io/berriai/litellm:main-latest
    ports:
      - "4000:4000"
    volumes:
      - ./litellm_config.yaml:/app/config.yaml
    command: --config /app/config.yaml
```

Configuration in Open WebUI admin panel:
1. Navigate to Admin > Settings > Connections
2. Delete existing OpenAI connection
3. Add new connection: URL = `http://localhost:4000/v1`, Key = your LiteLLM master key
4. All models defined in LiteLLM config appear automatically

#### Using Alongside Claude Code

Open WebUI and Claude Code can share the same LiteLLM proxy, giving you:
- **Open WebUI**: Browser-based chat interface for conversational tasks, model comparison, sharing conversations
- **Claude Code**: CLI-based development workflow with file editing, terminal access, MCP tools

Both interfaces see the same set of models (local and cloud) through the shared proxy.

#### Sharing Context Between Sessions

Direct context sharing between Open WebUI and Claude Code sessions is not natively supported, but practical workarounds exist:

1. **Shared files**: Both tools can read/write to the same filesystem. Export Open WebUI conversation summaries to files that Claude Code can read.
2. **Shared knowledge base**: Open WebUI supports RAG with document uploads. The same documents can be referenced in CLAUDE.md or via MCP tools.
3. **LiteLLM usage tracking**: Both tools' usage flows through LiteLLM, enabling unified cost and usage monitoring.
4. **Session Memory**: Claude Code's session memory persists across sessions. Open WebUI has its own conversation history. Cross-pollination requires manual file-based transfer.
5. **MCP tools**: An MCP server could expose Open WebUI's conversation history or search API as tools available to Claude Code.

#### User Tracking Across Both Interfaces

LiteLLM supports per-user tracking:
```yaml
general_settings:
  user_header_mappings:
    user_id_header: "x-openwebui-user-id"
```

This enables unified spend tracking across Open WebUI and Claude Code usage.

---

### 6. Existing Projects & Patterns

**Confidence: MEDIUM-HIGH** -- These projects exist and are actively developed, but maturity varies. Some are production-ready, others are experimental.

#### Ruflo (formerly claude-flow)

**Repository**: github.com/ruvnet/ruflo

A comprehensive agent orchestration platform for Claude Code featuring:
- 60+ agents, 170+ MCP tools
- Intelligent task routing: simple tasks skip LLM entirely (WebAssembly), medium tasks use cheaper models, complex tasks use Opus
- LiteLLM integration for multi-provider routing
- Cost tracking per model and per tenant
- Fallback chains: Code tasks -> GPT-4o-mini -> Qwen -> Local CodeLlama
- Production deployment with load-balanced proxies, PostgreSQL, Redis, Prometheus/Grafana

#### CCS (Claude Code Switch)

**Repository**: github.com/kaitranntt/ccs

Switches between Claude accounts, Gemini, Copilot, OpenRouter (300+ models) via CLI:
- Visual dashboard for model management
- CCS-Delegation skill for automatic task routing
- Reports $500-1000/month savings for typical users
- GLM handles 70% of tasks at 80% lower cost

#### claude-code-proxy

**Repository**: github.com/1rgs/claude-code-proxy

Runs Claude Code on OpenAI models by translating between Anthropic and OpenAI API formats.

#### llama-mcp-server

**Repository**: github.com/openconstruct/llama-mcp-server

MCP bridge connecting Claude Desktop/Code to local llama-server instances with full conversation support, parameter control, and health monitoring.

#### CC Mirror / OpenCode Agent Teams

The OpenCode project has implemented agent teams that can mix models from different providers in the same team -- something Claude Code's native agent teams cannot yet do. This enables coordination across GPT, Gemini, and Claude through the same message bus.

#### Claude Code Agentrooms

**Website**: claudecode.run

Open-source multi-agent development workspace that routes tasks to specialized AI agents and coordinates complex workflows.

#### Lightweight LiteLLM Proxy

**Repository**: github.com/niklas-palm/LiteLLM

A minimal LiteLLM proxy specifically designed for Claude Code, providing the simplest possible path to routing Claude Code through LiteLLM.

#### Community Patterns

Common patterns observed across the community:

1. **Tiered model usage**: Claude for architecture/design, local models for implementation/testing
2. **Offline-first with cloud fallback**: Local models for day-to-day work, Claude for complex problems
3. **Cost-optimized pipelines**: Route 70-80% of tasks to local/cheap models, reserve Claude for high-value tasks
4. **Privacy-sensitive routing**: All sensitive data processed locally, only anonymized queries go to cloud

---

## Routing Decision Matrix

| Task Type | Recommended Model | Reasoning | Latency | Cost |
|-----------|------------------|-----------|---------|------|
| Architecture design | Claude (Opus/Sonnet) | Requires deep reasoning, tradeoff analysis | Medium | High |
| Complex debugging | Claude (Sonnet) | Multi-file reasoning, hypothesis testing | Medium | High |
| Code review (security) | Claude (Sonnet) | Nuanced vulnerability detection | Medium | High |
| New feature implementation | Claude (Sonnet) | Context-aware code generation | Medium | High |
| Refactoring (complex) | Claude (Sonnet) | Understanding intent and dependencies | Medium | High |
| Summarization | Local 7B (e.g., Mistral 7B) | Well-handled by smaller models | Low | Free |
| Text classification | Local 7B | Fast pattern matching | Low | Free |
| Data extraction | Local 7B | Structured output from templates | Low | Free |
| Boilerplate generation | Local 7-13B | Template-based, repetitive | Low | Free |
| Embedding generation | Local embedding model | Dedicated task, no reasoning needed | Low | Free |
| Simple Q&A | Local 7B | Basic factual responses | Low | Free |
| Bulk text processing | Local 7B | Volume-oriented, parallelizable | Low | Free |
| Commit message generation | Local 7B | Formulaic, short output | Low | Free |
| Test generation (simple) | Local 13B | Pattern-based, from examples | Low | Free |
| Documentation drafts | Local 13B | Initial draft, Claude for polish | Low | Free |
| Refactoring (simple) | Local 13B | Rename, extract, mechanical transforms | Low | Free |
| Code explanation | Claude or Local 13B | Depends on complexity | Varies | Varies |

---

## Sources

1. LiteLLM Documentation - Routing & Load Balancing: https://docs.litellm.ai/docs/routing
2. LiteLLM - Claude Code with Non-Anthropic Models: https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models
3. Claude Code Docs - LLM Gateway Configuration: https://code.claude.com/docs/en/llm-gateway
4. LiteLLM - Auto Routing / Complexity Router: https://docs.litellm.ai/docs/proxy/auto_routing
5. LiteLLM - OpenAI Compatible Endpoints: https://docs.litellm.ai/docs/providers/openai_compatible
6. LiteLLM - Claude Code Max Subscription: https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription
7. LiteLLM - Open WebUI Integration: https://docs.litellm.ai/docs/tutorials/openweb_ui
8. LiteLLM - Fallbacks & Reliability: https://docs.litellm.ai/docs/proxy/reliability
9. Claude Code Docs - Agent Teams: https://code.claude.com/docs/en/agent-teams
10. Claude Code Docs - MCP Integration: https://code.claude.com/docs/en/mcp
11. Ruflo / Claude-Flow - LiteLLM Integration Wiki: https://github.com/ruvnet/ruflo/wiki/litellm-integration
12. Ruflo - Using Claude Code with Open Models: https://github.com/ruvnet/ruflo/wiki/Using-Claude-Code-with-Open-Models
13. CCS Delegation - Multi-Model Task Routing: https://mcpmarket.com/tools/skills/ccs-delegation
14. llama-mcp-server - MCP Bridge for llama.cpp: https://github.com/openconstruct/llama-mcp-server
15. roryp/mcpsampling - MCP with Multiple AI Providers: https://github.com/roryp/mcpsampling
16. Open WebUI + LiteLLM Docker Compose: https://github.com/chrispangg/openwebui-litellm
17. Open WebUI + LiteLLM Guide: https://dt.in.th/OpenWebUILiteLLM
18. XDA Developers - Claude Code + LM Studio Workflow: https://www.xda-developers.com/built-claude-code-workflow-lm-studio-offline-first-development/
19. LiteLLM - Proxy Load Balancing: https://docs.litellm.ai/docs/proxy/load_balancing
20. llama.cpp Server Documentation: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
21. DEV Community - Privacy-First MCP Server for llama.cpp: https://dev.to/kbrisso/local-privacy-first-mcp-server-for-llamacpp-ccb
22. Claude Code Proxy for OpenAI Models: https://github.com/1rgs/claude-code-proxy
23. CCS - Claude Code Switch: https://github.com/kaitranntt/ccs
24. Niklas Palm - Lightweight LiteLLM Proxy for Claude Code: https://github.com/niklas-palm/LiteLLM
25. Run Claude Code with Local & Cloud Models (Medium): https://medium.com/@luongnv89/run-claude-code-on-local-cloud-models-in-5-minutes-ollama-openrouter-llama-cpp-6dfeaee03cda
26. Shipyard - Multi-Agent Orchestration for Claude Code: https://shipyard.build/blog/claude-code-multi-agent/

---

## Implications

### Recommended Architecture for Your Setup

Given that you already have litellm, llama.cpp, and Open WebUI on Fedora with a Claude Code subscription:

**Phase 1: Unified Proxy (Start Here)**

1. Configure a LiteLLM proxy with your Claude subscription (OAuth forwarding) and local llama.cpp as backends
2. Point both Claude Code (`ANTHROPIC_BASE_URL`) and Open WebUI at the same LiteLLM instance
3. Use `claude --model <name>` to explicitly select local vs. cloud models as needed
4. Configure fallback chains so local models catch failures gracefully

**Phase 2: MCP-Based Delegation**

1. Deploy an MCP server (e.g., llama-mcp-server) that wraps your local llama.cpp endpoint
2. Add it to your Claude Code MCP configuration
3. Claude can now call local models as tools for summarization, classification, and bulk processing while maintaining its own reasoning for complex tasks
4. This preserves your subscription billing for Claude while offloading appropriate work locally

**Phase 3: Automatic Routing (When Ready)**

1. Enable LiteLLM's complexity router to automatically route simple tasks to local models
2. Tune tier boundaries and dimension weights based on your actual workload
3. Consider CCS-Delegation or a custom skill for Claude Code that encodes your routing preferences
4. Monitor cost savings through LiteLLM's tracking dashboard

### Key Advantages of This Architecture

- **Single proxy for everything**: LiteLLM unifies all model access for both Claude Code and Open WebUI
- **Subscription billing preserved**: OAuth forwarding means Claude Code subscription charges remain on your plan
- **Graceful degradation**: If Claude is unavailable or rate-limited, local models provide fallback
- **Privacy control**: Sensitive tasks route to local models, everything else can go to Claude
- **Cost optimization**: 70-80% of routine tasks can potentially run on local models for free
- **No vendor lock-in**: LiteLLM abstracts the provider layer, making it easy to swap models

---

## Open Questions

1. **Agent teams with mixed models**: Claude Code's experimental agent teams currently don't support specifying different model providers per teammate. When will this be available? OpenCode has already implemented this pattern.

2. **Complexity router accuracy**: How well does LiteLLM's rule-based complexity router work in practice for development tasks? The dimension weights may need tuning for code-heavy workloads where "code_presence" is always high.

3. **MCP tool overhead**: What is the latency overhead of routing through an MCP tool vs. direct LiteLLM proxy routing? For high-frequency calls, the extra hop through MCP may matter.

4. **Local model quality threshold**: At what parameter size do local models become "good enough" for summarization and classification in a development context? This needs benchmarking on your specific hardware (GPU VRAM, quantization level).

5. **Session context coherence**: When Claude delegates to a local model via MCP tool, the local model has no access to Claude's conversation context. How much context needs to be passed in the tool call for good results?

6. **Subscription rate limits**: Does routing through LiteLLM affect Claude Code subscription rate limits? The OAuth forwarding preserves your subscription identity, but the proxy adds a network hop.

7. **llama.cpp model selection**: Which GGUF model works best for the "local processing" role alongside Claude? Candidates include Mistral 7B Instruct, Qwen 2.5 Coder, and CodeLlama -- each with different strengths. This needs testing on your specific hardware.

8. **Open WebUI function calling**: Can Open WebUI's function/tool system be used to create routing logic similar to CCS-Delegation, providing a browser-based alternative to CLI-based routing?

9. **Automatic context sharing**: Is there a practical way to share conversation context between Open WebUI and Claude Code sessions beyond manual file export? A shared vector store accessed by both tools via MCP could work but needs implementation.

10. **Cost tracking accuracy**: LiteLLM tracks costs based on token pricing, but local model "costs" are electricity-based. How should the unified dashboard represent local model usage meaningfully?
