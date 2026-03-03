Alternatives to openclaw that are like wayyyy more stripped down and configurable ? Basically like my own agent harness. With Claude code and support for litellm and/or llama cpp (I’ve got both on my Linux machine. Litellm wraps llama cpp for some stuff like open web ui).
I will probably want this agent to run on my Linux machine as well. Maybe docker but maybe not idk. Options here?Here are the best stripped-down, highly configurable alternatives to OpenClaw that feel like "your own agent harness" — minimal codebases or libraries where you control the core loop/tools/memory/state, not a bloated full assistant with 50+ skills and chat gateways out of the box.
OpenClaw is great (full messaging + skills + always-on gateway), but these are 10-100x smaller/simpler, focused on letting you build/extend the agent logic. All run natively on Linux (your machine), support Claude (via Anthropic SDK or litellm), litellm (your existing setup for unifying everything), and llama.cpp (via litellm proxy/server or OpenAI-compatible endpoint). Docker is optional/easy for isolation/persistence.
1. Custom Python Harness with litellm (Most Stripped-Down Possible — Your Own 50-100 Line Script)
This is the ultimate "build it yourself" option. No framework overhead. litellm handles everything (Claude + your llama.cpp server + OpenAI etc. with one API).

Why it fits: Pure control. Implement ReAct/tool-calling loop, memory (simple dict or SQLite), tools (bash, file I/O, browser via Playwright, whatever). Add persistence with a loop + cron/systemd.
Claude + llama.cpp: litellm.completion(model="anthropic/claude-3-5-sonnet-20241022", ...) or your local: model="openai/my-llama", api_base="http://localhost:8080/v1" (run llama-server or your litellm proxy).
Linux setup:Bashpython -m venv agent-env && source agent-env/bin/activate
pip install litellm pydantic requests  # + whatever tools you needCopy a 70-line ReAct example (search "build production ai agents with litellm" — excellent tutorial). Run with nohup python agent.py & or tmux/systemd/Docker.
Docker: Trivial 5-line Dockerfile (python:3.12-slim + your script). Mount volumes for workspace.
Configurability: 100% yours. Add state machine, reflection, multi-agent, etc. in plain Python.
Repo/examples: litellm docs + the 70-line guide. Perfect starting point.

2. smolagents (Hugging Face) — Barebones Code-Centric Agent Library
Ultra-minimal (~1k LOC core). Agents "think by writing/executing Python code" (great for your "Claude code" vibe) or use tool-calling. Feels like a harness, not a product.

Why it fits: Stripped to essentials. Define tools/instructions, run agent loop. Supports sandboxed code exec.
litellm/Claude/llama.cpp: Native LiteLLMModel — just point it at your litellm instance or direct Anthropic. E.g., LiteLLMModel(model_id="anthropic/claude-3-5-sonnet-20241022") or your local llama model via litellm proxy.
Linux setup:Bashpip install smolagents  # or in venv10-20 lines to spin up a CodeAgent or ToolCallingAgent with your tools. Run as script or in loop.
Docker: Easy — base image + pip install, mount /workspace for safe file ops. Use for isolation.
Configurability: Extremely high. Custom tools, memory stores, multi-step reasoning, etc. All in code you own.
Repo: https://github.com/huggingface/smolagents (check examples — super clean).

3. LiteSwarm — Lightweight Framework Built Around litellm
Explicitly designed as a minimal agent harness with dynamic switching. Perfect match for your litellm setup.

Why it fits: Tiny core, LLM-agnostic via litellm, type-safe, streaming, stateful chat. Build specialized agents and switch them on the fly.
Claude/llama.cpp: 100% litellm backend — supports Anthropic natively + any local OpenAI-compat endpoint (your llama.cpp server).
Linux setup:Bashpip install liteswarmExample (from README):Pythonfrom liteswarm import Agent, Swarm, LLM
agent = Agent(id="my-agent", instructions="...", llm=LLM(model="anthropic/claude-3-5-sonnet-20241022"))
swarm = Swarm()
result = await swarm.run(...)  # or use SwarmChat for persistentAdd your tools with @tool_plain.
Docker: Standard Python app (easy compose with your litellm container side-by-side).
Configurability: High — custom agents, tools, switching logic, all minimal and extensible.
Repo: https://github.com/GlyphyAI/liteswarm

4. LangGraph (LangChain ecosystem) — Most Configurable Graph-Based Harness
If you want structured, production-grade custom agents (state machines, cycles, human-in-loop, memory), this is the gold standard for "build your own".

Why it fits: You define nodes/edges/state/tools exactly as you want. Starts minimal, scales to complex.
litellm/Claude/llama.cpp: Use langchain_anthropic for Claude or ChatOpenAI(base_url=your_litellm_proxy) for everything (Claude + llama.cpp). Full tool-calling support.
Linux setup:Bashpip install langgraph langchain-anthropic litellm  # or langchain-openai for proxyQuickstart: define a simple ReAct graph or your custom workflow (docs have 20-line examples).
Docker: Official examples + your litellm container. Persistent with volumes + Redis/Postgres for state if needed.
Configurability: Insanely high — this is the harness.
Repo/docs: https://github.com/langchain-ai/langgraph (start with "quick start" or "agent" tutorials).

5. Nanobot (HKUDS/nanobot) — If You Want a Tiny Pre-Built Assistant to Hack On
~4k LOC Python (99% smaller than OpenClaw). Full lightweight personal agent but way more stripped and readable.

Why it fits: Core agent loop + tools + memory + cron + sub-agents. Hack the Python directly (modular agent/loop.py, providers, skills).
Claude/llama.cpp: Direct Anthropic + custom OpenAI-compat/vLLM (plug your litellm or llama.cpp server endpoint). LiteLLM used internally for routing.
Linux setup: pip install nanobot-ai or git clone && pip install -e . + nanobot onboard. Docker + docker-compose included (perfect for your machine).
Configurability: JSON config + full code access. Add tools/providers in 2 steps.
Repo: https://github.com/HKUDS/nanobot (highly recommended if you want something runnable immediately but tiny).

Quick Deployment Tips for All (Linux Machine)

No Docker: venv + systemd service or tmux/screen for always-on. litellm can run as separate proxy service.
With Docker: 1-line compose (python base + your code + volume for workspace + restart: unless-stopped). Run litellm in its own container if not already.
Security note (important for any agent with tools/shell): Use Docker isolation or E2B/sandbox for code exec. Start with read-only workspace + approvals for dangerous actions. Never give full root.

Start with smolagents or the custom litellm script if you want maximum "my own harness" feel — you'll have something running in <30 mins that does exactly what you want with Claude + your local models. If you need multi-chat (Telegram/WhatsApp) later, layer it on top or check NanoClaw/PicoClaw for even lighter gateway options.
Let me know which direction you're leaning (e.g., pure coding agents? multi-step workflows? specific tools?) and I can drop exact code snippets or Dockerfiles. Happy hacking! 🦞 (but smaller)Doesn’t seem like any of those support the claude code CLI or STK so it doesn’t fit with my requirements. I need the subscription billing to apply to the setup. I’m not paying for API credit either local or subscription based.The stripped-down options that actually support Claude Code CLI (or its SDK-equivalent) with your Claude Pro/Max subscription billing (no extra API credits, no pay-per-token console billing) are much more limited — because Anthropic's official Agent SDK (what you called STK) explicitly requires an API key and forbids using claude.ai login/subscription quotas in third-party products.
Claude Code CLI (claude command) is the one that logs in with your claude.ai account → bills directly to your subscription quota (far cheaper/more predictable). The Python SDK bundles the CLI binary, and community wrappers use OAuth token from claude.ai/code, so those work.
Here are the actual fits for a minimal, fully-configurable "my own agent harness" on Linux (Docker optional but recommended for safety/isolation). All run natively, support the full Claude Code agentic capabilities (file read/edit, bash commands, MCP tools, sessions, memory via .claude/ files, etc.), and you own the outer loop/state/tools.
1. Pure Custom Python Harness Wrapping claude CLI (Most Stripped-Down — Your Own 50-200 Line Script)
This is the ultimate "build it yourself" that feels exactly like a personal agent harness. No framework bloat. You control everything, and it uses the real claude CLI (subscription billing).

Why perfect: Call subprocess to claude -p "your prompt" --json or pipe stdin/stdout, resume sessions (-c), add your own state/memory/persistence, multi-step loops, reflection, tool approvals. Add MCP servers for extra tools. Hybrid with litellm/llama.cpp super easy (if prompt says "use local", route to litellm instead of claude CLI).
Setup on Linux (5 mins):Bashcurl -fsSL https://claude.ai/install.sh | bash   # installs `claude` CLI globally
claude auth login   # uses your Pro/Max account → subscription onlyThen your harness script (example skeleton):Pythonimport subprocess, json, os
def run_claude(prompt, session=None, tools=None):
    cmd = ["claude", "-p", prompt]
    if session: cmd += ["-c", session]
    if tools: cmd += ["--mcp-config", json.dumps(tools)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return json.loads(result.stdout)  # or parse stdout
# Your loop: ReAct, state in SQLite/JSON, approvals, cron/systemd, etc.
litellm/llama.cpp support: Trivial — if "local" in prompt: litellm.completion(...) else: run_claude(...)
Docker: One-line Dockerfile (ubuntu + curl install + your script + volume for workspace). Run with --restart unless-stopped.
Configurability: 100% yours (add Telegram/Slack webhook, persistent memory, custom hooks, sub-agents via multiple CLI sessions).
Repo/examples: Just search "claude cli python wrapper" or look at the community OpenClaw-replacements people posted (cron + claude CLI + Telegram).

2. claude-agent-toolkit (cheolwanpark/claude-agent-toolkit) — Ready-Made Minimal Harness Using Claude Code
This is literally "build your own agent" on top of Claude Code's engine, with zero bloat. Uses OAuth token from claude.ai/code → pure subscription billing.

Why fits: Decorator-based custom tools (@tool), Docker-isolated execution by default, built-in FileSystemTool with permissions, parallel tools, MCP integration, full control over agent loop/prompt/model. Feels like your harness but with the heavy lifting (tool calling, context, safety) handled by Claude Code CLI under the hood.
Key advantages over raw CLI: Runtime isolation (Docker), type-safe data transfer, easy state management, error handling.
Linux setup:Bashpip install claude-agent-toolkit
export CLAUDE_CODE_OAUTH_TOKEN=your_token_from_claude.ai/code   # subscription onlyExample (10 lines):Pythonfrom claude_agent_toolkit import Agent, tool
@tool("my_custom_bash")
def run_bash(cmd: str): ...
agent = Agent(tools=[run_bash, ...], executor="docker")  # or subprocess for dev
result = agent.query("do the thing")
Docker: Built-in (default mode), slim images, perfect for your machine. Subprocess mode if you skip Docker.
litellm hybrid: Add a tool that calls litellm (or run separate local agent and route).
Repo: https://github.com/cheolwanpark/claude-agent-toolkit — examples include calculator, file mgmt, weather, external MCP. Extremely readable and extensible.

3. Official claude-agent-sdk-python (anthropics) — If You Use CLI Mode
The official programmable version of Claude Code. Bundles the CLI binary, so you can point it at your subscription-installed claude.

Why it works for sub billing: Uses the bundled/real CLI path (not the API-key-only mode). Custom tools via @tool + MCP servers, hooks for full control (PreToolUse etc.), streaming, sessions.
Setup:Bashpip install claude-agent-sdk
# CLI already installed via subscriptionThen:Pythonfrom claude_agent_sdk import ClaudeAgent, ClaudeAgentOptions
options = ClaudeAgentOptions(cli_path="/usr/local/bin/claude", ...)  # points to sub version
agent = ClaudeAgent(options)
Configurability: Insanely high (same as what powers Claude Code itself: hooks, allowed_tools, project context files).
Docker: Trivial — same as any Python app.
Repo: https://github.com/anthropics/claude-agent-sdk-python (examples + quick_start.py)

Quick Linux Deployment (All Options)

No Docker: venv + systemd service or tmux. claude CLI runs fine.
With Docker: Compose file with your harness container + mounted workspace + restart policy. Add litellm container side-by-side if you want hybrid routing.
Always-on like OpenClaw: Cron + your harness script, or simple FastAPI/Telegram bot wrapper that triggers the agent.
Security: Use Docker + permission rules in Claude Code (--allow flags) + tool approvals in your harness. Never give unrestricted bash.

These are way more stripped and "yours" than OpenClaw — you're basically just orchestrating the official Claude Code engine (subscription-powered) with your own Python glue. No 50 skills gateway, no extra billing.
Start with #1 (custom wrapper) if you want maximum ownership, or #2 (toolkit) if you want decorator-based tools + isolation out of the box. Both support litellm/llama.cpp as an easy add-on for hybrid use.
Drop which one you're leaning toward (or paste your current OpenClaw config) and I'll give the exact Dockerfile + starter script + how to add Telegram persistence. This will feel like home. 🦞 (but official and cheaper)Yeah okay. I already have Claude code sdk wrapped in a custom harness thing that converts to websockets but also maybe pure is also easy enough. But like I’m sure that isn’t all that open claw is?Yeah, you're spot on — your current setup (Claude Code SDK wrapped in a custom harness with WebSocket conversion for real-time-ish interaction) already captures a big chunk of what makes OpenClaw powerful for many people: persistent Claude Code sessions, tool execution (file ops, bash, MCP tools, etc.), and some form of always-on/notify loop via websockets.
But no, that's not all OpenClaw is — it's way more of an "always-on life OS / digital twin" layer built around one or more agent backends (heavily Claude Code / Claude models, but model-agnostic). The core differences boil down to these layers that your pure SDK + harness probably doesn't have out of the box (or would require you to build manually):
What OpenClaw Adds Beyond "Just Running Claude Code"

Multi-channel always-on gateway (the killer feature for most users):
It bridges to WhatsApp, Telegram, Signal, Discord, Slack, iMessage (via BlueBubbles), Matrix, Google Chat, Teams, even Zalo — all with session continuity. You text the same agent on your phone via WhatsApp → continue on desktop Slack → it remembers everything. Your websocket harness might do one channel (e.g., custom web UI or single bot), but OpenClaw handles 10+ with unified state.
Heartbeat / cron scheduler for autonomous / proactive behavior:
It wakes up periodically (configurable interval) without user input — checks emails/calendar/GitHub notifications/X mentions, runs scheduled tasks (e.g., daily summary, monitor logs, auto-PR reviews), or self-invokes on timers. Pure Claude Code sessions are reactive (you prompt → it acts); OpenClaw turns it proactive/autonomous.
Persistent, file-based long-term memory & personality system:
Everything lives as Markdown/YAML files on disk (SOUL.md for personality/boundaries, memory.md for recall, project files, git-backed history). It compacts/refreshes context across sessions, learns over time, and has "Soul" patterns for vibe/consistency. Claude Code has session compaction, but OpenClaw's is disk-persistent, git-versioned, and multi-agent friendly.
Modular skill ecosystem (ClawHub):
Community-shared SKILL.md files (YAML + natural-language instructions) that auto-install/searchable. Things like GitHub integration (auto-PR on tags), Linear tasks, Notion sync, browser automation, email triage. You can prompt the agent to draft new skills. Your harness could replicate with custom tools, but OpenClaw has a registry + auto-discovery.
Multi-agent orchestration primitives:
Spawns sub-agents (e.g., research + writing + review teams), coordinates via files/git/cron, supports model mixing (Claude Opus for director, Sonnet/DeepSeek for cheap workers). Includes visual canvas / node-based workflows in newer versions.
Sandboxing & security layers (mixed success stories):
Dockerized execution for tools/browser, permission prompts, watchdog for crashes. (Though real-world reports show it can still go rogue if not hardened.)

In short: Your setup is basically "Claude Code with a websocket pipe" — excellent for interactive/reactive use (coding, quick tasks). OpenClaw is that plus a full autonomous personal assistant shell: multi-messaging, proactive cron/heartbeat, disk-git memory, skill plugins, multi-agent, and "lives in your chats" UX.
If You Want to Keep It Stripped-Down But Add Some of Those Bits
Since you already have a harness:

Add proactive polling → simple cron job that triggers your websocket loop with a "check inbox / due tasks" prompt every X minutes.
Multi-channel → layer on something lightweight like matrix-appservice-irc-style bridge or use n8n / Activepieces to route messages from WhatsApp/Telegram into your websocket endpoint.
Persistent memory → just dump/append to JSON/Markdown files in your workspace dir (Claude Code already supports project context files — lean on that).
Skills → implement as prompt templates or MCP servers you spin up dynamically.

If that's still too manual and you miss the "plug-and-play channels + cron" magic without the full OpenClaw bloat (or security drama), look at:

NanoClaw or PicoClaw forks/variants — lighter spins focused on secure/single-channel + Claude Code.
Claw-empire (GitHub: GreenSheep01201/claw-empire) — office-sim style orchestrator for multiple CLI agents (Claude Code + others), less gateway-heavy.
Direct Anthropic updates (Cowork scheduled tasks + Claude Code remote control) — these are eating into OpenClaw's niche natively now, with better security.

If you share more about what part of OpenClaw you actually envy most (e.g., WhatsApp always-on? cron proactivity? skill plugins?), I can give exact snippets to bolt that onto your existing harness without pulling in the whole lobster empire. Your stripped approach is honestly smarter for control + billing predictability anyway. 🦞