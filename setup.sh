#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

# ── Colors ───────────────────────────────────────────────────────
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
dim()   { printf "\033[90m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

# ── Prereqs ──────────────────────────────────────────────────────
bold "checking prerequisites..."

if command -v bun &>/dev/null; then
  green "  ✓ bun $(bun --version 2>/dev/null | head -1)"
else
  echo "  bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  green "  ✓ bun installed ($(bun --version 2>/dev/null))"
fi

if command -v uv &>/dev/null; then
  green "  ✓ $(uv --version 2>/dev/null | head -1)"
else
  echo "  uv not found — installing..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  green "  ✓ uv installed ($(uv --version 2>/dev/null))"
fi

# ── Install JS deps (skip if already installed) ─────────────────
echo ""
if [ -d "$ROOT/harness/node_modules" ]; then
  dim "  harness deps already installed, skipping"
else
  bold "installing harness dependencies..."
  cd "$ROOT/harness"
  bun install
fi

echo ""
if [ -d "$ROOT/harness/ui/node_modules" ]; then
  dim "  UI deps already installed, skipping"
else
  bold "installing UI dependencies..."
  cd "$ROOT/harness/ui"
  bun install
fi

# ── Sync Python deps (skip if venv exists) ──────────────────────
echo ""
if [ -f "$ROOT/agent_memory/.venv/bin/python" ]; then
  dim "  agent-memory Python deps already synced, skipping"
else
  bold "syncing agent-memory Python deps..."
  cd "$ROOT/agent_memory"
  uv sync
fi

# ── MCP config ───────────────────────────────────────────────────
cd "$ROOT"
if [ ! -f .mcp.json ]; then
  echo ""
  bold "creating .mcp.json from example..."
  cp .mcp.json.example .mcp.json
  # Patch the relative path to an absolute path
  if command -v sed &>/dev/null; then
    abs_mem="$ROOT/agent_memory"
    # Cross-platform sed: try GNU then BSD
    sed -i "s|./agent_memory|$abs_mem|g" .mcp.json 2>/dev/null \
      || sed -i '' "s|./agent_memory|$abs_mem|g" .mcp.json
  fi
  green "  created .mcp.json (agent-memory path → $ROOT/agent_memory)"
else
  dim "  .mcp.json already exists, skipping"
fi

# ── Launch ───────────────────────────────────────────────────────
echo ""
green "setup complete! launching..."
echo "  API :3777  |  UI :5180"
echo ""
cd "$ROOT/harness"
exec bun run dev
