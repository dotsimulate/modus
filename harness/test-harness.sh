#!/bin/bash
# Test 3: Full harness — start server, hit endpoints, shut down
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
unset CLAUDECODE

echo "=== Starting harness ==="
bun run index.ts &
SERVER_PID=$!
sleep 3

echo "=== Health check ==="
curl -s http://localhost:3001/health
echo ""

echo "=== Streaming query ==="
curl -N -s -X POST http://localhost:3001/api/agent/stream \
  -H "Content-Type: application/json" \
  -d '{"prompt": "respond with just the word hello", "maxTurns": 1}' \
  --max-time 45
echo ""

echo "=== Shutting down ==="
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
echo "Done"
