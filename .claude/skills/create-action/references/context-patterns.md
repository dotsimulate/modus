# Context Patterns

The `context.ts` module builds dynamic prompts, verifies results, and can act on them.

**IMPORTANT:** context.ts lives in `.modus/actions/<name>/` which can be in ANY project
directory. Everything you need is on `ctx` — the `ActionContext` object passed to every
function. The only import you need is the type import (erased at compile time):

```typescript
import type { ActionContext, RunResult, VerifyResult } from "../../action-types";
```

Use `fs` for reading project files. Use `moves` on the action for structured context
gathering (memory, status, etc.).

## Module Interface

```typescript
import type { ActionContext, ActionContent, RunResult, VerifyResult } from "../../action-types";

// Required: build the prompt sent to the agent as the user message
export async function gather(ctx: ActionContext): Promise<string | ActionContent>;

// Optional: inspect output and decide whether to accept, reject, or retry
// Only called when maxRetries > 0
export async function verify(ctx: ActionContext, result: RunResult): Promise<VerifyResult>;

// Optional: run side effects after the agent session completes successfully
// NOT called on failed-verification or error — only on success.
// Failures here are logged but do NOT change the run's status.
export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void>;
```

## ActionContext

```typescript
{
  actionName: string;        // "health-monitor"
  executionId: number;       // which execution this run belongs to
  runNumber: number;         // global run counter (1, 2, 3...)
  cycleNumber: number;       // current cycle (1-based)
  cycleRunIndex: number;     // 0-based index within current cycle
  lastRunAt: Date | null;    // when the previous run completed
  db: ActionDB;              // database access (read + write)
  trigger: TriggerInfo;      // { type, payload?, source? }
  actionDir: string;         // absolute path to actions/<name>/

  // ── Multi-step context ──
  stepIndex: number;         // 0 for single-step or step 0, 1+ for subsequent
  totalSteps: number;        // 1 for single-step actions
  previousStepResult?: SessionOutcome | null;

  // ── Verify/retry context ──
  attempt: number;           // 1-based, 1 = first try
  lastVerifyError?: string;  // reason from failed verify, if retrying

  // ── Logging ──
  log(message: string, metadata?: Record<string, unknown>): void;

  // ── Artifact helpers ──
  artifactDir(): string;     // output dir for this run, created on first access
  artifactPath(filename: string): string;  // path within artifactDir
  artifact(name: string): string;  // path for a declared artifact (extension from mime)

  // ── Terminal ──
  createTerminal(opts?: {
    cwd?: string; shell?: string; cols?: number; rows?: number;
    env?: Record<string, string>;
  }): ActionTerminalHandle;
  // Returns: { id, write(data), kill(), waitForExit() }
  // Terminal appears live in the right side panel (ownerType=action)

  // ── Utilities ──
  svgToPngBase64(svgPath: string, width?: number): string | null;  // render SVG to base64 PNG
}
```

## Database API (ctx.db)

ctx.db is scoped to what the action needs — its own run history and targeted session
mutations. It does NOT provide general-purpose queries across all sessions or projects.

```typescript
// ── This action's run history (scoped to current action) ──
ctx.db.getRunSummaries(limit?: number): RunSummary[]    // this action's summaries (oldest first)
ctx.db.getRunHistory(limit?: number): RunMeta[]          // this action's runs (newest first)
ctx.db.getActionRuns(name: string, limit?: number): RunMeta[]  // another action's runs

// ── Targeted session mutations (use with session IDs from trigger payloads) ──
ctx.db.updateSessionTitle(id: string, title: string | null): void
ctx.db.addSessionTag(id: string, tag: string): void      // no-op if already present
ctx.db.removeSessionTag(id: string, tag: string): void    // no-op if not present
```

**Use run history** (`getRunSummaries`, `getRunHistory`) to build context from previous
runs of this action. These are scoped — they only return this action's data.

**Use session mutations** (`updateSessionTitle`, `addSessionTag`) only with specific
session IDs from trigger payloads (e.g., auto-titling a session that triggered the action).

**For project-local context** (memory files, config, status), read files from the
project directory using `fs` and `ctx.actionDir`. For structured context gathering,
use `moves` on the action — attach a companion move that reads memory and builds prompts.

## VerifyResult

```typescript
{ ok: true }
// or
{ ok: false, reason: string, retry?: boolean }
// retry: true → re-enter gather/session loop if attempts remain
// retry: false or omitted → fail immediately as "failed-verification"
```

## RunResult

```typescript
{
  status: "done" | "error" | "failed-verification" | "error-transient";
  response: string | null;    // agent's final response text
  summary: string | null;     // truncated version stored in DB
  costUsd: number;
  durationMs: number;
  sessionId: string | null;
  error: string | null;
}
```

## TriggerInfo

```typescript
{
  type: "interval" | "webhook" | "manual" | "action" | "session";
  payload?: unknown;     // webhook body, RunResult from source action, or SessionTriggerPayload
  source?: string;       // source action name (for chain triggers)
}
```

## Pattern: Basic Dynamic Context

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const history = ctx.db.getRunSummaries(10);
  const past = history.length > 0
    ? `\n\nPrevious runs:\n${history.map(
        r => `- Run #${r.runNumber}: ${r.summary}`
      ).join("\n")}`
    : "\n\nThis is the first run.";

  return `Run #${ctx.runNumber}. ${new Date().toISOString()}.\nCheck system health.` + past;
}
```

## Pattern: Session Mutation (afterRun)

```typescript
import type { ActionContext, RunResult, SessionTriggerPayload } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const payload = ctx.trigger.payload as SessionTriggerPayload;
  return `Generate a concise title for: "${payload.preview}"\nRespond with ONLY the title.`;
}

export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void> {
  const payload = ctx.trigger.payload as SessionTriggerPayload;
  if (!result.response) return;

  const title = result.response.trim().replace(/^["']|["']$/g, "").replace(/\.+$/, "");
  if (!title) return;

  ctx.db.updateSessionTitle(payload.sessionId, title);
  ctx.db.addSessionTag(payload.sessionId, "auto-titled");
}
```

## Pattern: Verify + Retry (File Output)

```typescript
import type { ActionContext, RunResult, VerifyResult } from "../../action-types";
import { existsSync, statSync } from "fs";

export async function gather(ctx: ActionContext): Promise<string> {
  const base = `Create an SVG cartoon. Save it to: ${ctx.artifact("cartoon")}`;

  if (ctx.attempt > 1 && ctx.lastVerifyError) {
    return `${base}\n\nPrevious attempt failed: ${ctx.lastVerifyError}\nPlease fix this issue.`;
  }
  return base;
}

export async function verify(ctx: ActionContext, result: RunResult): Promise<VerifyResult> {
  if (result.status !== "done") return { ok: false, reason: "session error" };

  const path = ctx.artifact("cartoon");
  if (!existsSync(path)) return { ok: false, reason: "SVG file not created", retry: true };

  const size = statSync(path).size;
  if (size < 100) return { ok: false, reason: `SVG too small (${size} bytes)`, retry: true };

  // Use ctx.svgToPngBase64 to verify it actually renders
  const rendered = ctx.svgToPngBase64(path);
  if (!rendered) return { ok: false, reason: "SVG failed to render to PNG", retry: true };

  return { ok: true };
}
```

Note: if you declare `artifacts` in action.json and don't write a `verify()`, the runner
auto-verifies that each required artifact exists and is non-empty. Write `verify()` only
when you need custom validation (size thresholds, content checks, etc.).

## Pattern: Auto-Verify (No verify() Needed)

Just declare artifacts in action.json and use `ctx.artifact()` in gather:

```json
{
  "artifacts": [{ "name": "report", "mime": "application/json" }],
  "maxRetries": 2
}
```

```typescript
export async function gather(ctx: ActionContext): Promise<string> {
  const path = ctx.artifact("report");
  let hint = "";
  if (ctx.attempt > 1 && ctx.lastVerifyError) {
    hint = `\n\nPrevious attempt failed: ${ctx.lastVerifyError}`;
  }
  return `Generate a JSON report and save it to: ${path}${hint}`;
}
```

The runner will automatically check that `report.json` exists and is non-empty.

## Pattern: Multipart Content (Text + Images)

```typescript
import type { ActionContext, ActionContent } from "../../action-types";
import { readFileSync } from "fs";

export async function gather(ctx: ActionContext): Promise<ActionContent> {
  const imageData = readFileSync("/path/to/image.png").toString("base64");

  return [
    { type: "text", text: `Analyze this image. Run #${ctx.runNumber}.` },
    { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
  ];
}
```

## Pattern: SVG → PNG for Image Telephone

```typescript
import type { ActionContext, ActionContent } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string | ActionContent> {
  const svgPath = "/path/to/previous.svg";
  const pngBase64 = ctx.svgToPngBase64(svgPath);

  if (!pngBase64) {
    return `The previous SVG could not be rendered. Create a new one from scratch.`;
  }

  return [
    { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
    { type: "text", text: `That image is the previous iteration. Create a new version.` },
  ];
}
```

## Pattern: Webhook Payload Processing

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const payload = ctx.trigger.payload as any;

  if (ctx.trigger.type === "webhook" && payload) {
    const commits = payload.commits?.map((c: any) => `- ${c.message}`).join("\n") ?? "none";
    const branch = payload.ref?.replace("refs/heads/", "") ?? "unknown";
    return `GitHub push to ${branch}:\n${commits}\n\nReview these changes.`;
  }

  return `Manual trigger — run a general code review.`;
}
```

## Pattern: Chain Context (action trigger)

When an action fires from a chain, the source action's RunResult is in `ctx.trigger.payload`:

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const sourceResult = ctx.trigger.payload as any;

  if (ctx.trigger.type === "action" && sourceResult) {
    return (
      `Previous action "${ctx.trigger.source}" completed: ${sourceResult.status}.\n` +
      `Summary: ${sourceResult.summary ?? "none"}\n\n` +
      `Based on this result, perform follow-up analysis.`
    );
  }

  return `Manual trigger — run standard analysis.`;
}
```

## Pattern: Multi-Step Sequence

When an action uses `steps`, gather may be called multiple times with different `stepIndex`:

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  if (ctx.stepIndex === 0) {
    return `Write a draft blog post about ${new Date().toISOString().split("T")[0]}.`;
  }
  // Step 1+: the profile has been switched, previous result available
  const prev = ctx.previousStepResult;
  return `Review and improve the draft above. Previous status: ${prev?.sessionStatus}`;
}
```

## Pattern: Cycle-Aware Prompting

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  if (ctx.cycleRunIndex === 0) {
    return `Starting cycle #${ctx.cycleNumber}. Do a comprehensive scan.`;
  }
  const history = ctx.db.getRunSummaries(5);
  return (
    `Follow-up #${ctx.cycleRunIndex + 1} in cycle #${ctx.cycleNumber}. ` +
    `Check items from previous runs:\n` +
    history.map(r => `- ${r.summary}`).join("\n")
  );
}
```

## Pattern: afterRun Side Effects

```typescript
import type { ActionContext, RunResult } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  return `Run #${ctx.runNumber}. Check system health.`;
}

export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void> {
  if (!result.response) return;

  // Example: call an external API based on the result
  const hasAlert = /critical|down|failed/i.test(result.response);
  if (hasAlert) {
    await fetch("https://hooks.slack.com/services/xxx/yyy/zzz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Alert from ${ctx.actionName} run #${ctx.runNumber}:\n${result.summary}`
      })
    });
  }
}
```

Note: for simple notifications (webhook, file), prefer declarative `notify` in action.json
over custom afterRun code. Use afterRun for complex logic that can't be expressed declaratively.

## Pattern: Artifact Path Usage

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  // Declared artifact — use ctx.artifact() for spec-aware path
  const cartoonPath = ctx.artifact("cartoon");

  // Ad-hoc file — use ctx.artifactPath() for arbitrary files
  const logPath = ctx.artifactPath("debug.log");

  return `Create a cartoon SVG at ${cartoonPath}. Log debug info to ${logPath}.`;
}
```

## Pattern: Action + Move Composition

When an action declares `moves`, each move's gather() runs and the output is prepended
to the action's prompt. The action's context.ts gather() provides additional context on
top of what the moves provide.

```json
{
  "name": "morning-checkin",
  "agentProfile": "companion-agent",
  "trigger": { "type": "interval", "every": "1d",
    "activeHours": { "start": "09:00", "end": "10:00" } },
  "moves": [{ "name": "check-in" }],
  "maxTurns": 20
}
```

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  // The check-in move's gather() already ran and its output is prepended.
  // This gather() adds action-specific context on top.
  const history = ctx.db.getRunSummaries(5);
  const lastCheckin = history.length > 0
    ? `Last check-in: ${history[0].summary}`
    : "This is the first scheduled check-in.";

  return [
    "This is a scheduled morning check-in.",
    lastCheckin,
    "Have a natural conversation. When done, save what you learned.",
  ].join("\n");
}
```

The move handles structured context gathering (reading memory files, building
conversational prompts). The action handles scheduling and run history. Neither
needs to duplicate the other's logic.

For API contract moves in the `moves` array, the API token is automatically
registered on the spawned session — the agent can call ops immediately.

## Cost Awareness

- **Haiku** actions: retry freely (cheap). `maxRetries: 3` is fine.
- **Sonnet** actions: moderate retries. `maxRetries: 1-2`.
- **Opus** actions: cap retries. `maxRetries: 0-1` — each retry is expensive.
- Use `maxTurns` conservatively on expensive models.
- Check `result.costUsd` in afterRun if you need cost-based decisions.

## Pattern: Terminal (Live CLI in Side Panel)

Use `ctx.createTerminal()` to spawn a PTY that appears live in the right side panel.
Good for dev servers, builds, test runners — anything with streaming output.

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const term = ctx.createTerminal({ cwd: "/path/to/project" });
  term.write("bun run dev\n");

  return "Dev server started. Terminal is live in the side panel.";
}
```

The terminal is owned by the action (`ownerType=action`) and auto-detected by the
right panel. It appears as a new tab immediately.

### Terminal + waitForExit (run a command and report result)

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const term = ctx.createTerminal();
  term.write("npm test\n");

  const exitCode = await term.waitForExit();
  if (exitCode !== 0) {
    return `Tests failed (exit ${exitCode}). Check the terminal for output.`;
  }
  return "All tests passed.";
}
```

### Terminal handle API

```typescript
term.id: string;                           // terminal ID
term.write(data: string): void;            // write to stdin
term.kill(): void;                         // kill the process
term.waitForExit(): Promise<number | null> // await exit code
```
