/**
 * Process boundary used by the Modus Antigravity plugin.
 *
 * Antigravity invokes this file through its documented JSON Hooks interface.
 * The hook forwards lifecycle JSON into a turn-scoped IPC directory and, for
 * PreToolUse, waits for the Modus provider to return an allow/deny decision.
 */

import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";

type HookMode = "pre-invocation" | "pre-tool" | "post-tool" | "stop";

function writeHookResult(value: Record<string, unknown>): never {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

function failClosed(message: string): never {
  process.stderr.write(`[modus-antigravity-hook] ${message}\n`);
  const requestedMode = process.argv[2] as HookMode | undefined;
  if (requestedMode === "pre-tool") writeHookResult({ decision: "deny", reason: message });
  if (requestedMode === "stop") writeHookResult({ decision: "stop", reason: message });
  writeHookResult({});
}

const mode = process.argv[2] as HookMode | undefined;
const ipcDir = process.env.MODUS_ANTIGRAVITY_HOOK_DIR;
if (!mode || !ipcDir) failClosed("missing hook mode or IPC directory");

let input: Record<string, any>;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch (error) {
  failClosed(`invalid hook input: ${error instanceof Error ? error.message : String(error)}`);
}

const requestId = mode === "pre-tool"
  ? `agy-${input.conversationId ?? "unknown"}-${input.stepIdx ?? "step"}-${crypto.randomUUID()}`
  : undefined;
const event = { kind: mode, requestId, at: Date.now(), input };
try {
  appendFileSync(join(ipcDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
} catch (error) {
  failClosed(`could not forward hook event: ${error instanceof Error ? error.message : String(error)}`);
}

if (mode === "pre-invocation") {
  const instructionPath = join(ipcDir, "profile-instructions.json");
  if (existsSync(instructionPath)) {
    try {
      const instruction = JSON.parse(readFileSync(instructionPath, "utf8")) as { text?: unknown };
      if (typeof instruction.text === "string" && instruction.text.trim()) {
        writeHookResult({ injectSteps: [{ ephemeralMessage: instruction.text }] });
      }
    } catch (error) {
      failClosed(`invalid Modus profile instruction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  writeHookResult({});
}
if (mode === "post-tool") writeHookResult({});
if (mode === "stop") {
  if (input.fullyIdle === false) {
    writeHookResult({
      decision: "continue",
      reason: "Finish or stop active background tasks before returning the final Modus response.",
    });
  }
  writeHookResult({ decision: "stop" });
}
if (!requestId) failClosed("PreToolUse request has no request ID");

const responsePath = join(ipcDir, `${requestId}.response.json`);
const deadline = Date.now() + 23 * 60 * 60 * 1000;
while (!existsSync(responsePath) && Date.now() < deadline) {
  await Bun.sleep(50);
}
if (!existsSync(responsePath)) failClosed("Modus permission response timed out");

try {
  const response = JSON.parse(readFileSync(responsePath, "utf8")) as {
    behavior?: "allow" | "deny";
    message?: string;
  };
  if (response.behavior === "allow") writeHookResult({ decision: "allow" });
  writeHookResult({ decision: "deny", reason: response.message ?? "Denied in Modus" });
} catch (error) {
  failClosed(`invalid Modus permission response: ${error instanceof Error ? error.message : String(error)}`);
}
