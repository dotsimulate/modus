#!/bin/bash
# Launch Modus with watchdog from anywhere.
# Usage: ./modus.sh [init [path]|watch|watch:dev|start|dev]
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIG_DIR="$PWD"
cd "$SCRIPT_DIR/harness"
bun install
if [ "${1:-}" = "setup" ]; then
    exec bun run setup.ts
elif [ "${1:-}" = "init" ]; then
    exec bun run cli-init.ts "${2:-}" "$ORIG_DIR"
else
    exec bun run "${1:-watch}" "${@:2}"
fi
