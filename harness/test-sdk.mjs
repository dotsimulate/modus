import { query } from "@anthropic-ai/claude-agent-sdk";

console.log("Starting query...");
const q = query({
  prompt: "say hello",
  options: {
    pathToClaudeCodeExecutable: process.env.HOME + "/.local/bin/claude",
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    allowedTools: [],
  }
});
for await (const msg of q) {
  console.log("MSG:", JSON.stringify(msg).slice(0, 500));
}
console.log("Done");
