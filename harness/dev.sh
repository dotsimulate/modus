#!/bin/bash
# Dev mode: starts harness API + Vite dev server with HMR
# Both bind to 0.0.0.0 for LAN access.
#
# Ports: HARNESS_PORT (default 3777), frontend 5180
# Auth: HARNESS_TOKEN (auto-generated if unset, "" to disable)
#
# Usage: ./dev.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
unset CLAUDECODE

export HARNESS_PORT="${HARNESS_PORT:-3777}"

# Generate token if not set
if [ -z "${HARNESS_TOKEN+x}" ]; then
  export HARNESS_TOKEN=$(openssl rand -hex 16)
fi

cleanup() {
  echo ""
  echo "shutting down..."
  kill $HARNESS_PID $VITE_PID 2>/dev/null
  wait $HARNESS_PID $VITE_PID 2>/dev/null
  echo "done"
}
trap cleanup EXIT INT TERM

# Start harness API
cd "$SCRIPT_DIR"
bun run index.ts &
HARNESS_PID=$!

# Start Vite dev server (proxies /api to harness)
cd "$SCRIPT_DIR/ui"
VITE_HARNESS_TOKEN="$HARNESS_TOKEN" bun run dev &
VITE_PID=$!

sleep 2

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
HOSTNAME_LOCAL=$(hostname).local

echo ""
echo "  harness  http://localhost:${HARNESS_PORT}"
echo "  frontend http://localhost:5180"
if [ -n "$LAN_IP" ]; then
  echo ""
  echo "  LAN      http://${LAN_IP}:5180"
  echo "           http://${HOSTNAME_LOCAL}:5180"
fi
if [ -n "$HARNESS_TOKEN" ]; then
  echo ""
  echo "  token    $HARNESS_TOKEN"
fi
echo ""
echo "  ctrl+c to stop both"

wait
