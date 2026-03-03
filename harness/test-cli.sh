#!/bin/bash
# Test 1: Can the CLI run outside a nested session?
echo "=== Test: CLI direct ==="
unset CLAUDECODE
timeout 30 claude -p "respond with just the word hello" --output-format json --max-turns 1 2>&1 | head -5
echo ""
echo "Exit code: $?"
