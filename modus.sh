#!/bin/bash
# Launch Modus with watchdog from anywhere.
# Usage: ./modus.sh [watch|watch:dev|start|dev]
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/harness"
exec bun run "${1:-watch}" "${@:2}"
