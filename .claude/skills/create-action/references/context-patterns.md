# Context Patterns

The `context.ts` module builds dynamic prompts, verifies results, and can act on them.

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
  db: ActionDB;              // read-only database access
  trigger: TriggerInfo;      // { type, payload?, source? }
  actionDir: string;         // absolute path to actions/<name>/

  // ── Multi-step context ──
  stepIndex: number;         // 0 for single-step or step 0, 1+ for subsequent
  totalSteps: number;        // 1 for single-step actions
  previousStepResult?: SessionOutcome | null;

  // ── Verify/retry context ──
  attempt: number;           // 1-based, 1 = first try
  lastVerifyError?: string;  // reason from failed verify, if retrying

  // ── Artifact helpers ──
  artifactDir(): string;     // output dir for this run, created on first access
  artifactPath(filename: string): string;  // path within artifactDir
  artifact(name: string): string;  // path for a declared artifact (extension from mime)
}
```

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
  type: "interval" | "webhook" | "manual" | "action";
  payload?: unknown;     // webhook body, or RunResult from source action
  source?: string;       // source action name (for chain triggers)
}
```

## Database API (ctx.db)

```typescript
ctx.db.getRunSummaries(limit?: number): RunSummary[]    // this action's summaries (oldest first)
ctx.db.getRunHistory(limit?: number): RunMeta[]          // this action's runs (newest first)
ctx.db.getActionRuns(name: string, limit?: number): RunMeta[]  // any action's runs
ctx.db.listSessions(limit?: number): SessionInfo[]       // recent sessions
ctx.db.getSession(id: string): SessionInfo | null
ctx.db.searchSessions(query: string, limit?: number): SearchResult[]
ctx.db.getEvents(sessionId: string, afterSeq?: number): EventInfo[]
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
import type { ActionContext, RunResult } from "../../action-types";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export async function gather(ctx: ActionContext): Promise<string> {
  // Declared artifact — use ctx.artifact() for spec-aware path
  const cartoonPath = ctx.artifact("cartoon");

  // Ad-hoc file — use ctx.artifactPath() for arbitrary files
  const logPath = ctx.artifactPath("debug.log");

  return `Create a cartoon SVG at ${cartoonPath}. Log debug info to ${logPath}.`;
}
```

## Cost Awareness

- **Haiku** actions: retry freely (cheap). `maxRetries: 3` is fine.
- **Sonnet** actions: moderate retries. `maxRetries: 1-2`.
- **Opus** actions: cap retries. `maxRetries: 0-1` — each retry is expensive.
- Use `maxTurns` conservatively on expensive models.
- Check `result.costUsd` in afterRun if you need cost-based decisions.
