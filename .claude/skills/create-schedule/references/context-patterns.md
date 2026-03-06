# Context Patterns

The `context.ts` module is the power feature of MO schedules. It builds dynamic
prompts and can act on results after the agent completes.

## Module Interface

```typescript
import type { ScheduleContext, RunResult } from "../../scheduler-types";

// Required: build the prompt sent to the agent as the user message
export async function gather(ctx: ScheduleContext): Promise<string>;

// Optional: run side effects after the agent session completes
export async function afterRun(ctx: ScheduleContext, result: RunResult): Promise<void>;
```

## ScheduleContext (what gather() receives)

```typescript
{
  scheduleName: string;       // "health-monitor"
  runNumber: number;          // global run counter (1, 2, 3...)
  cycleNumber: number;        // current cycle (1-based)
  cycleRunIndex: number;      // 0-based index within current cycle
  lastRunAt: Date | null;     // when the previous run completed
  db: ScheduleDB;             // read-only database access
}
```

## RunResult (what afterRun() receives)

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

The `db` object provides read-only access to schedule history and sessions:

```typescript
// This schedule's completed run summaries (oldest first)
ctx.db.getRunSummaries(limit?: number): RunSummary[]

// This schedule's full run metadata (newest first)
ctx.db.getRunHistory(limit?: number): RunMeta[]

// Any schedule's runs by name
ctx.db.getScheduleRuns(scheduleName: string, limit?: number): RunMeta[]

// Recent non-archived sessions
ctx.db.listSessions(limit?: number): SessionInfo[]

// Get a specific session
ctx.db.getSession(id: string): SessionInfo | null

// Full-text search across session content
ctx.db.searchSessions(query: string, limit?: number): SearchResult[]

// Event stream for a session
ctx.db.getEvents(sessionId: string, afterSeq?: number): EventInfo[]
```

## Pattern: Basic Dynamic Context

The simplest useful context.ts — adds run history to the prompt:

```typescript
import type { ScheduleContext } from "../../scheduler-types";

export async function gather(ctx: ScheduleContext): Promise<string> {
  const history = ctx.db.getRunSummaries(10);

  const past = history.length > 0
    ? `\n\nPrevious runs:\n${history.map(
        r => `- Run #${r.runNumber}: ${r.summary}`
      ).join("\n")}`
    : "\n\nThis is the first run.";

  return (
    `Run #${ctx.runNumber}. ${new Date().toISOString()}.` +
    `\nCheck system health and report status.` +
    past
  );
}
```

## Pattern: External Data Gathering

Fetch live data to feed into the agent's prompt:

```typescript
import type { ScheduleContext } from "../../scheduler-types";

export async function gather(ctx: ScheduleContext): Promise<string> {
  // Fetch external data before the agent runs
  const metrics = await fetch("http://localhost:9090/api/v1/query?query=up")
    .then(r => r.json()).catch(() => null);

  const status = metrics
    ? `Current metrics:\n${JSON.stringify(metrics.data, null, 2)}`
    : "Could not fetch metrics (endpoint unreachable).";

  return (
    `Monitoring run #${ctx.runNumber}. Time: ${new Date().toISOString()}\n\n` +
    status +
    `\n\nAnalyze these metrics. Flag anything abnormal. Be concise.`
  );
}
```

## Pattern: Cross-Schedule Awareness

Read results from other schedules to build context:

```typescript
import type { ScheduleContext } from "../../scheduler-types";

export async function gather(ctx: ScheduleContext): Promise<string> {
  // Check what the monitoring schedule found
  const monitorRuns = ctx.db.getScheduleRuns("health-monitor", 5);
  const errors = monitorRuns.filter(r => r.status === "error");

  // Search past sessions for related context
  const related = ctx.db.searchSessions("deployment failure", 3);

  return (
    `Daily report run #${ctx.runNumber}.\n\n` +
    `Health monitor: ${monitorRuns.length} recent runs, ${errors.length} errors.\n` +
    (related.length > 0
      ? `Related sessions found:\n${related.map(r => `- ${r.snippet}`).join("\n")}\n`
      : "") +
    `\nGenerate a concise daily summary.`
  );
}
```

## Pattern: Cycle-Aware Prompting

Adjust behavior based on position within a cycle:

```typescript
import type { ScheduleContext } from "../../scheduler-types";

export async function gather(ctx: ScheduleContext): Promise<string> {
  const isFirstInCycle = ctx.cycleRunIndex === 0;
  const history = ctx.db.getRunSummaries(5);

  if (isFirstInCycle) {
    return (
      `Starting cycle #${ctx.cycleNumber}. ` +
      `Do a comprehensive scan of all services. This is the deep check.`
    );
  }

  return (
    `Follow-up check #${ctx.cycleRunIndex + 1} in cycle #${ctx.cycleNumber}. ` +
    `Only check items flagged in previous runs:\n` +
    history.map(r => `- ${r.summary}`).join("\n")
  );
}
```

## Pattern: afterRun with Notifications

Act on the agent's response after it completes:

```typescript
import type { ScheduleContext, RunResult } from "../../scheduler-types";

export async function gather(ctx: ScheduleContext): Promise<string> {
  return `Run #${ctx.runNumber}. Check system health. Report any issues.`;
}

export async function afterRun(ctx: ScheduleContext, result: RunResult): Promise<void> {
  if (result.status === "error" || !result.response) return;

  // Parse the agent's response for alerts
  const hasAlert = result.response.toLowerCase().includes("critical")
    || result.response.toLowerCase().includes("down");

  if (hasAlert) {
    // Send webhook notification
    await fetch("https://hooks.slack.com/services/xxx/yyy/zzz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Alert from ${ctx.scheduleName} run #${ctx.runNumber}:\n${result.summary}`
      })
    });
  }
}
```

## Pattern: afterRun Writing Results to Disk

```typescript
import type { ScheduleContext, RunResult } from "../../scheduler-types";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export async function gather(ctx: ScheduleContext): Promise<string> {
  return `Generate the daily project status report. Format as markdown.`;
}

export async function afterRun(ctx: ScheduleContext, result: RunResult): Promise<void> {
  if (result.status !== "done" || !result.response) return;

  const dir = join("/home/user/reports", ctx.scheduleName);
  await mkdir(dir, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  await writeFile(
    join(dir, `${date}-run${ctx.runNumber}.md`),
    result.response
  );
}
```

## Pattern: afterRun Calling an API

```typescript
import type { ScheduleContext, RunResult } from "../../scheduler-types";

export async function gather(ctx: ScheduleContext): Promise<string> {
  return `Analyze the latest sensor readings and return a JSON object with: { temperature: number, humidity: number, status: "ok" | "warning" | "critical" }`;
}

export async function afterRun(ctx: ScheduleContext, result: RunResult): Promise<void> {
  if (result.status !== "done" || !result.response) return;

  try {
    // Extract JSON from agent response
    const match = result.response.match(/\{[\s\S]*\}/);
    if (!match) return;
    const data = JSON.parse(match[0]);

    // Forward to home automation
    await fetch("http://homeassistant.local:8123/api/states/sensor.room_status", {
      method: "POST",
      headers: {
        "Authorization": "Bearer YOUR_TOKEN",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ state: data.status, attributes: data })
    });
  } catch (e) {
    console.error(`afterRun failed: ${e}`);
  }
}
```

## Pattern: Conditional Scheduling (Skip Runs)

The `gather()` function can signal the agent to do minimal work based on conditions:

```typescript
import type { ScheduleContext } from "../../scheduler-types";

export async function gather(ctx: ScheduleContext): Promise<string> {
  // Check if there's actually work to do
  const recentErrors = ctx.db.getRunHistory(5).filter(r => r.status === "error");

  if (recentErrors.length === 0 && ctx.cycleRunIndex > 0) {
    return "No issues detected in previous runs. Reply with just 'OK' and nothing else.";
  }

  return (
    `Errors detected in ${recentErrors.length} recent runs. ` +
    `Investigate and provide detailed diagnostics.`
  );
}
```

## Full Example: Complete Schedule Stack

For a "monitor my web app every 15 minutes" request, create three files:

### 1. Agent profile: `profiles/agents/webapp-monitor.json`

```json
{
  "description": "Web app health monitor",
  "prompt": "You are a web application monitoring agent. Check endpoints, analyze responses, and report issues clearly.",
  "model": "claude-sonnet-4-6",
  "effort": "medium",
  "maxTurns": 5,
  "tools": ["Read", "Bash", "Grep"],
  "permissionPolicy": { "default": "approve" }
}
```

### 2. Schedule config: `schedules/webapp-monitor/schedule.json`

```json
{
  "name": "webapp-monitor",
  "description": "Check web app health every 15 minutes during business hours",
  "agentProfile": "webapp-monitor",
  "interval": "15m",
  "activeHours": { "start": "08:00", "end": "20:00" },
  "maxTurns": 5,
  "enabled": false
}
```

### 3. Context module: `schedules/webapp-monitor/context.ts`

```typescript
import type { ScheduleContext, RunResult } from "../../scheduler-types";

const ENDPOINTS = [
  "https://myapp.com/health",
  "https://myapp.com/api/status",
  "https://myapp.com/api/db-check"
];

export async function gather(ctx: ScheduleContext): Promise<string> {
  const results = await Promise.allSettled(
    ENDPOINTS.map(url =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then(r => ({ url, status: r.status, ok: r.ok }))
    )
  );

  const report = results.map((r, i) => {
    if (r.status === "fulfilled") {
      return `${ENDPOINTS[i]}: ${r.value.status} ${r.value.ok ? "OK" : "FAILED"}`;
    }
    return `${ENDPOINTS[i]}: UNREACHABLE (${r.reason?.message ?? "timeout"})`;
  }).join("\n");

  const history = ctx.db.getRunSummaries(5);

  return (
    `Health check #${ctx.runNumber}. Time: ${new Date().toISOString()}\n\n` +
    `Endpoint status:\n${report}\n\n` +
    (history.length > 0
      ? `Recent history:\n${history.map(h => `- Run #${h.runNumber}: ${h.summary}`).join("\n")}\n\n`
      : "") +
    `Analyze these results. If anything is down or degraded, explain what you see.`
  );
}

export async function afterRun(ctx: ScheduleContext, result: RunResult): Promise<void> {
  if (result.status !== "done" || !result.response) return;

  const isCritical = result.response.match(/down|unreachable|500|failed/i);
  if (isCritical) {
    await fetch("https://hooks.slack.com/services/xxx/yyy/zzz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Web app alert (run #${ctx.runNumber}):\n${result.summary}`
      })
    });
  }
}
```
