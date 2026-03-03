// Test 2: SDK query directly
delete process.env.CLAUDECODE;

import { query } from "@anthropic-ai/claude-agent-sdk";

console.log("=== Test: SDK query ===");
console.log("CLAUDE_PATH:", process.env.HOME + "/.local/bin/claude");

const q = query({
  prompt: "respond with just the word hello",
  options: {
    pathToClaudeCodeExecutable: process.env.HOME + "/.local/bin/claude",
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
  },
});

let count = 0;
for await (const msg of q) {
  count++;
  console.log(`MSG ${count} [${msg.type}]:`, JSON.stringify(msg).slice(0, 300));
}
console.log(`\nTotal messages: ${count}`);
