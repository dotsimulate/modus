# Context Patterns

The `context.ts` module builds dynamic prompts and can act on results.

## Module Interface

```typescript
import type { ActionContext, RunResult } from "../../action-types";

// Required: build the prompt sent to the agent as the user message
export async function gather(ctx: ActionContext): Promise<string>;

// Optional: run side effects after the agent session completes
// Failures here are logged but do NOT change the run's status.
export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void>;
```

## ActionContext

```typescript
{
  actionName: string;        // "health-monitor"
  runNumber: number;         // global run counter (1, 2, 3...)
  cycleNumber: number;       // current cycle (1-based)
  cycleRunIndex: number;     // 0-based index within current cycle
  lastRunAt: Date | null;    // when the previous run completed
  db: ActionDB;              // read-only database access
  trigger: TriggerInfo;      // { type, payload?, source? }
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

## RunResult

```typescript
{
  status: "done" | "error";
  response: string | null;    // agent's final response text
  summary: string | null;     // truncated version stored in DB
  costUsd: number;
  durationMs: number;
  sessionId: string | null;
  error: string | null;
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

## Pattern: External Data Gathering

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const metrics = await fetch("http://localhost:9090/api/v1/query?query=up")
    .then(r => r.json()).catch(() => null);

  return (
    `Monitoring run #${ctx.runNumber}. Time: ${new Date().toISOString()}\n\n` +
    (metrics ? `Metrics:\n${JSON.stringify(metrics.data, null, 2)}` : "Metrics unavailable.") +
    `\n\nAnalyze and flag anything abnormal. Be concise.`
  );
}
```

## Pattern: Webhook Payload Processing

The webhook body is available via `ctx.trigger.payload`:

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const payload = ctx.trigger.payload as any;

  if (ctx.trigger.type === "webhook" && payload) {
    // GitHub push webhook
    const commits = payload.commits?.map((c: any) => `- ${c.message}`).join("\n") ?? "none";
    const branch = payload.ref?.replace("refs/heads/", "") ?? "unknown";

    return (
      `GitHub push to ${branch}:\n${commits}\n\n` +
      `Review these changes. Check for potential issues.`
    );
  }

  return `Manual trigger — run a general code review.`;
}
```

## Pattern: Cross-Action Awareness

```typescript
import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const monitorRuns = ctx.db.getActionRuns("health-monitor", 5);
  const errors = monitorRuns.filter(r => r.status === "error");
  const related = ctx.db.searchSessions("deployment failure", 3);

  return (
    `Daily report #${ctx.runNumber}.\n` +
    `Health monitor: ${monitorRuns.length} recent runs, ${errors.length} errors.\n` +
    (related.length > 0 ? `Related: ${related.map(r => r.snippet).join("; ")}\n` : "") +
    `Generate a concise summary.`
  );
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
      `Previous action "${ctx.trigger.source}" completed with status: ${sourceResult.status}.\n` +
      `Response summary: ${sourceResult.summary ?? "none"}\n\n` +
      `Based on this result, perform the follow-up analysis.`
    );
  }

  return `Manual trigger — run standard analysis.`;
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

## Pattern: afterRun Notifications

```typescript
import type { ActionContext, RunResult } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  return `Run #${ctx.runNumber}. Check system health.`;
}

export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void> {
  if (result.status === "error" || !result.response) return;

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

## Pattern: afterRun Writing to Disk

```typescript
import type { ActionContext, RunResult } from "../../action-types";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export async function gather(ctx: ActionContext): Promise<string> {
  return `Generate the daily project status report. Format as markdown.`;
}

export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void> {
  if (result.status !== "done" || !result.response) return;
  const dir = join("/home/user/reports", ctx.actionName);
  await mkdir(dir, { recursive: true });
  const date = new Date().toISOString().split("T")[0];
  await writeFile(join(dir, `${date}-run${ctx.runNumber}.md`), result.response);
}
```

## Full Example: Webhook-Triggered Deploy Review

### 1. `profiles/agents/deploy-reviewer.json`

```json
{
  "description": "Reviews code changes from deployment webhooks",
  "prompt": "You review code deployments. Check for security issues, performance problems, and best practice violations.",
  "model": "claude-sonnet-4-6",
  "maxTurns": 10,
  "tools": ["Read", "Bash", "Grep", "Glob"]
}
```

### 2. `actions/deploy-review/action.json`

```json
{
  "name": "deploy-review",
  "description": "Review code changes when triggered by GitHub webhook",
  "agentProfile": "deploy-reviewer",
  "trigger": { "type": "webhook" },
  "maxTurns": 10,
  "enabled": true
}
```

### 3. `actions/deploy-review/context.ts`

```typescript
import type { ActionContext, RunResult } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  const payload = ctx.trigger.payload as any;
  if (ctx.trigger.type !== "webhook" || !payload) {
    return "No webhook payload. Do a general code review of recent changes.";
  }

  const commits = payload.commits?.map((c: any) =>
    `- ${c.id?.slice(0, 7)} ${c.message} (${c.author?.name})`
  ).join("\n") ?? "No commits";

  const repo = payload.repository?.full_name ?? "unknown";
  const branch = payload.ref?.replace("refs/heads/", "") ?? "unknown";

  return (
    `GitHub push to ${repo} on ${branch}:\n${commits}\n\n` +
    `Review these changes for security, performance, and correctness issues.`
  );
}

export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void> {
  if (result.status !== "done" || !result.response) return;
  const hasIssues = /warning|issue|problem|vulnerability/i.test(result.response);
  if (hasIssues) {
    console.log(`[deploy-review] Issues found in run #${ctx.runNumber} — would notify here`);
  }
}
```
