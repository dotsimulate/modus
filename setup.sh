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

missing=0
for cmd in bun uv; do
  if command -v "$cmd" &>/dev/null; then
    green "  ✓ $cmd $(command $cmd --version 2>/dev/null | head -1)"
  else
    red "  ✗ $cmd not found"
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  echo ""
  red "install missing tools before continuing:"
  echo "  bun  → https://bun.sh"
  echo "  uv   → https://docs.astral.sh/uv/"
  exit 1
fi

# ── Install JS deps ─────────────────────────────────────────────
echo ""
bold "installing harness dependencies..."
cd "$ROOT/harness"
bun install

echo ""
bold "installing UI dependencies..."
cd "$ROOT/harness/ui"
bun install

# ── Sync Python deps ────────────────────────────────────────────
echo ""
bold "syncing agent-memory Python deps..."
cd "$ROOT/agent_memory"
uv sync

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

# ── Done ─────────────────────────────────────────────────────────
echo ""
green "setup complete!"
echo ""
echo "  start:  cd harness && bun run dev"
echo "          cd harness; bun run dev   (PowerShell)"
echo "  ports:  API :3777  |  UI :5180"
echo ""
dim "first launch will prompt you to set a PIN."
