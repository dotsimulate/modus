#!/bin/bash
# Launch Modus with watchdog from anywhere.
# Usage: ./modus.sh [open [path]|init [path]|watch|watch:dev|start|dev]
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIG_DIR="$PWD"
cd "$SCRIPT_DIR/harness"
bun install
if [ "${1:-}" = "setup" ]; then
    exec bun run setup.ts
elif [ "${1:-}" = "init" ]; then
    exec bun run cli-init.ts "${2:-}" "$ORIG_DIR"
elif [ "${1:-}" = "open" ]; then
    # Resolve target: explicit arg or caller's CWD
    if [ -n "${2:-}" ]; then
        TARGET="$(cd "$ORIG_DIR" && cd "$2" && pwd)"
    else
        TARGET="$ORIG_DIR"
    fi
    # Auto-init if .modus/ doesn't exist
    if [ ! -d "$TARGET/.modus" ]; then
        echo "No .modus/ found — initializing project in $TARGET"
        bun run cli-init.ts "" "$TARGET"
    fi
    echo "Opening project: $TARGET"
    export AGENT_CWD="$TARGET"
    exec bun run watchdog.ts
else
    exec bun run "${1:-watch}" "${@:2}"
fi
