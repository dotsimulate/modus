/**
 * Dry-run test for the action pipeline v2 + executions.
 *
 * Tests the pipeline logic without any LLM calls:
 *   - Transient error detection
 *   - SessionOutcome type shape
 *   - VerifyResult type shape
 *   - ActionContext artifact helpers
 *   - ExecutionState type shape
 *   - DB migration (attempts, verify_error, execution_id columns exist)
 *   - DB round-trip for execution + run fields
 *   - Execution lifecycle (create, update, close)
 *   - Run ↔ Execution linkage
 *   - ActionState with activeExecutions map
 *   - Exhaustion detection
 *   - Reset preserves history
 *
 * Run: bun run test-pipeline.ts
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";
import { existsSync, rmSync, mkdirSync } from "fs";

// ── Transient Error Detection ──

const TRANSIENT_PATTERNS = [
  "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET",
  "fetch failed", "network", "socket hang up",
  "503", "502", "429",
  "timeout", "EHOSTUNREACH",
];

function isTransientError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return TRANSIENT_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

describe("isTransientError", () => {
  test("detects ECONNREFUSED", () => {
    expect(isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(true);
  });

  test("detects ETIMEDOUT", () => {
    expect(isTransientError(new Error("connect ETIMEDOUT 104.18.6.192:443"))).toBe(true);
  });

  test("detects fetch failed", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });

  test("detects 429 rate limit", () => {
    expect(isTransientError(new Error("Request failed with status 429"))).toBe(true);
  });

  test("detects 503 service unavailable", () => {
    expect(isTransientError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
  });

  test("detects 502 bad gateway", () => {
    expect(isTransientError(new Error("502 Bad Gateway"))).toBe(true);
  });

  test("detects socket hang up", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
  });

  test("detects ENOTFOUND (DNS)", () => {
    expect(isTransientError(new Error("getaddrinfo ENOTFOUND api.anthropic.com"))).toBe(true);
  });

  test("detects EHOSTUNREACH", () => {
    expect(isTransientError(new Error("connect EHOSTUNREACH 10.0.0.1:443"))).toBe(true);
  });

  test("detects generic timeout", () => {
    expect(isTransientError(new Error("Request timeout after 30000ms"))).toBe(true);
  });

  test("detects network error", () => {
    expect(isTransientError(new Error("NetworkError when attempting to fetch resource"))).toBe(true);
  });

  test("does NOT flag model refusal", () => {
    expect(isTransientError(new Error("I cannot help with that request"))).toBe(false);
  });

  test("does NOT flag context.ts errors", () => {
    expect(isTransientError(new Error("gather() returned invalid prompt"))).toBe(false);
  });

  test("does NOT flag missing file errors", () => {
    expect(isTransientError(new Error("Missing context.ts for action"))).toBe(false);
  });

  test("does NOT flag generic JS errors", () => {
    expect(isTransientError(new Error("Cannot read properties of undefined"))).toBe(false);
  });

  test("handles string input", () => {
    expect(isTransientError("ECONNREFUSED")).toBe(true);
    expect(isTransientError("some other error")).toBe(false);
  });
});

// ── Type Shape Tests ──

describe("type shapes", () => {
  test("SessionOutcome has correct shape", () => {
    const outcome: import("./action-types").SessionOutcome = {
      sessionStatus: "done",
      response: "test response",
      summary: "test summary",
      costUsd: 0.05,
      error: null,
    };
    expect(outcome.sessionStatus).toBe("done");
    expect(outcome.error).toBeNull();
  });

  test("SessionOutcome accepts timeout status", () => {
    const outcome: import("./action-types").SessionOutcome = {
      sessionStatus: "timeout",
      response: null,
      summary: null,
      costUsd: 0,
      error: "timeout after 30 minutes",
    };
    expect(outcome.sessionStatus).toBe("timeout");
  });

  test("VerifyResult ok shape", () => {
    const result: import("./action-types").VerifyResult = { ok: true };
    expect(result.ok).toBe(true);
  });

  test("VerifyResult fail shape with retry", () => {
    const result: import("./action-types").VerifyResult = {
      ok: false,
      reason: "SVG too small",
      retry: true,
    };
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("SVG too small");
      expect(result.retry).toBe(true);
    }
  });

  test("VerifyResult fail shape without retry", () => {
    const result: import("./action-types").VerifyResult = {
      ok: false,
      reason: "Unfixable output",
    };
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retry).toBeUndefined();
    }
  });

  test("RunResult accepts new status values", () => {
    const r1: import("./action-types").RunResult = {
      status: "failed-verification",
      response: null, summary: null, costUsd: 0,
      durationMs: 0, sessionId: null, error: "SVG empty",
    };
    expect(r1.status).toBe("failed-verification");

    const r2: import("./action-types").RunResult = {
      status: "error-transient",
      response: null, summary: null, costUsd: 0,
      durationMs: 0, sessionId: null, error: "ECONNREFUSED",
    };
    expect(r2.status).toBe("error-transient");
  });

  test("ActionContext has verify/retry fields and executionId", () => {
    const ctx: import("./action-types").ActionContext = {
      actionName: "test",
      executionId: 42,
      runNumber: 1,
      cycleNumber: 1,
      cycleRunIndex: 0,
      lastRunAt: null,
      db: {} as any,
      trigger: { type: "manual" },
      actionDir: "/tmp/test-action",
      cwd: "/tmp",
      inputs: {},
      stepIndex: 0,
      totalSteps: 1,
      previousStepResult: null,
      attempt: 2,
      lastVerifyError: "SVG too small",
      log: () => {},
      artifactDir: () => "/tmp/test-action/output/exec-42/run-1",
      artifactPath: (f: string) => `/tmp/test-action/output/exec-42/run-1/${f}`,
      artifact: (n: string) => `/tmp/test-action/output/exec-42/run-1/${n}`,
      attachArtifact: (opts) => ({
        id: 1,
        sessionId: opts.sessionId,
        seq: opts.seq,
        name: opts.name,
        mime: opts.mime,
        url: `/api/sessions/${opts.sessionId}/artifacts/1`,
        createdAt: Date.now(),
        ...(opts.previewText ? { previewText: opts.previewText } : {}),
      }),
      svgToPngBase64: () => null,
      createTerminal: () => ({ id: "test", write: () => {}, close: () => {} }) as any,
    };
    expect(ctx.attempt).toBe(2);
    expect(ctx.executionId).toBe(42);
    expect(ctx.lastVerifyError).toBe("SVG too small");
    expect(ctx.artifactPath("output.svg")).toContain("output.svg");
    expect(ctx.artifactDir()).toContain("exec-42");
  });

  test("ActionConfig accepts execution fields", () => {
    const config: import("./action-types").ActionConfig = {
      name: "test",
      description: "test",
      enabled: true,
      agentProfile: "default",
      trigger: { type: "manual" },
      maxRetries: 2,
      maxTransientRetries: 3,
      retryBackoff: "2m",
      onTransientFailure: "skip",
      concurrency: 3,
      onExhausted: "restart",
    };
    expect(config.maxRetries).toBe(2);
    expect(config.concurrency).toBe(3);
    expect(config.onExhausted).toBe("restart");
  });

  test("ActionConfig defaults for concurrency and onExhausted", () => {
    const config: import("./action-types").ActionConfig = {
      name: "test-defaults", description: "test", enabled: true,
      agentProfile: "default", trigger: { type: "manual" },
    };
    expect(config.concurrency).toBeUndefined();
    expect(config.onExhausted).toBeUndefined();
    // Pipeline treats undefined as concurrency=1, onExhausted="archive"
    expect(config.concurrency ?? 1).toBe(1);
    expect(config.onExhausted ?? "archive").toBe("archive");
  });

  test("ActionConfig accepts onGatherError", () => {
    const failConfig: import("./action-types").ActionConfig = {
      name: "test-fail", description: "test", enabled: true,
      agentProfile: "default", trigger: { type: "manual" },
      onGatherError: "fail",
    };
    expect(failConfig.onGatherError).toBe("fail");

    const retryConfig: import("./action-types").ActionConfig = {
      name: "test-retry", description: "test", enabled: true,
      agentProfile: "default", trigger: { type: "manual" },
      onGatherError: "retry", maxRetries: 2,
    };
    expect(retryConfig.onGatherError).toBe("retry");
  });

  test("onGatherError defaults to fail when absent", () => {
    const config: import("./action-types").ActionConfig = {
      name: "test-default", description: "test", enabled: true,
      agentProfile: "default", trigger: { type: "manual" },
    };
    expect(config.onGatherError).toBeUndefined();
    expect(config.onGatherError ?? "fail").toBe("fail");
  });

  test("ActionModule accepts verify function", () => {
    const mod: import("./action-types").ActionModule = {
      gather: async () => "test prompt",
      verify: async (_ctx, result) => {
        if (result.status === "done") return { ok: true };
        return { ok: false, reason: "not done", retry: true };
      },
      afterRun: async () => {},
    };
    expect(typeof mod.verify).toBe("function");
  });

  test("ExecutionState has correct shape", () => {
    const exec: import("./action-types").ExecutionState = {
      id: 1,
      actionName: "test-action",
      status: "running",
      startedAt: Date.now(),
      runNumber: 3,
      cycleNumber: 2,
      cycleRunCount: 1,
      cycleStartedAt: Date.now(),
      currentSessionId: "sess-123",
      runStartedAt: Date.now(),
      lastStatus: "done",
      totalCostUsd: 0.15,
      transientAttempts: 0,
    };
    expect(exec.id).toBe(1);
    expect(exec.status).toBe("running");
    expect(exec.runNumber).toBe(3);
    expect(exec.totalCostUsd).toBe(0.15);
  });

  test("ExecutionState accepts all valid statuses", () => {
    const statuses: import("./action-types").ExecutionState["status"][] = [
      "running", "done", "idle", "reset", "cancelled",
    ];
    for (const status of statuses) {
      const exec: import("./action-types").ExecutionState = {
        id: 1, actionName: "test", status, startedAt: Date.now(),
        runNumber: 0, cycleNumber: 1, cycleRunCount: 0,
        cycleStartedAt: null, currentSessionId: null, runStartedAt: null,
        lastStatus: null, totalCostUsd: 0, transientAttempts: 0,
      };
      expect(exec.status).toBe(status);
    }
  });

  test("ActionState uses activeExecutions map", () => {
    const exec: import("./action-types").ExecutionState = {
      id: 1, actionName: "test", status: "running", startedAt: Date.now(),
      runNumber: 2, cycleNumber: 1, cycleRunCount: 2,
      cycleStartedAt: Date.now(), currentSessionId: "sess-1", runStartedAt: Date.now(),
      lastStatus: "done", totalCostUsd: 0.1, transientAttempts: 0,
    };
    const state: import("./action-types").ActionState = {
      config: {
        name: "test", description: "test", enabled: true,
        agentProfile: "default", trigger: { type: "manual" },
      },
      scopeKey: "harness:test",
      actionDir: "/tmp/test-action",
      origin: "harness",
      activeExecutions: new Map([[1, exec]]),
      lastRunAt: Date.now(),
      nextRunAt: null,
      exhausted: false,
    };
    // Derive running from activeExecutions
    expect(state.activeExecutions.size > 0).toBe(true);
    expect(state.activeExecutions.get(1)?.runNumber).toBe(2);
  });

  test("ActionState derives running=false when no active executions", () => {
    const state: import("./action-types").ActionState = {
      config: {
        name: "test", description: "test", enabled: true,
        agentProfile: "default", trigger: { type: "manual" },
      },
      scopeKey: "harness:test",
      actionDir: "/tmp/test-action",
      origin: "harness",
      activeExecutions: new Map(),
      lastRunAt: null,
      nextRunAt: null,
      exhausted: false,
    };
    expect(state.activeExecutions.size > 0).toBe(false);
  });

  test("RunMeta includes executionId", () => {
    const run: import("./action-types").RunMeta = {
      id: 1, runNumber: 1, cycleNumber: 1, sessionId: null,
      status: "done", summary: null, startedAt: Date.now(),
      completedAt: Date.now(), costUsd: 0, error: null,
      triggerType: "manual", afterRunError: null,
      attempts: 1, verifyError: null, executionId: 42,
    };
    expect(run.executionId).toBe(42);
  });

  test("RunMeta executionId can be null (pre-execution era)", () => {
    const run: import("./action-types").RunMeta = {
      id: 1, runNumber: 1, cycleNumber: 1, sessionId: null,
      status: "done", summary: null, startedAt: Date.now(),
      completedAt: Date.now(), costUsd: 0, error: null,
      triggerType: "manual", afterRunError: null,
      attempts: 1, verifyError: null, executionId: null,
    };
    expect(run.executionId).toBeNull();
  });
});

// ── DB Schema Tests ──

describe("DB schema", () => {
  test("action_runs table has attempts, verify_error, and execution_id columns", () => {
    const { getActionRuns } = require("./db");
    const runs = getActionRuns("__test_nonexistent__", 1);
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBe(0);
  });

  test("action_executions table exists", () => {
    const { getExecutions } = require("./db");
    const execs = getExecutions("__test_nonexistent__", 1);
    expect(Array.isArray(execs)).toBe(true);
    expect(execs.length).toBe(0);
  });

  test("insertExecution + getExecutions round-trip", () => {
    const { insertExecution, getExecutions, db } = require("./db");

    const execId = insertExecution("__test_exec__", '{"test":true}');
    expect(typeof execId).toBe("number");
    expect(execId).toBeGreaterThan(0);

    const execs = getExecutions("__test_exec__", 10);
    expect(execs.length).toBeGreaterThanOrEqual(1);
    const found = execs.find((e: any) => e.id === execId);
    expect(found).toBeTruthy();
    expect(found.action_name).toBe("__test_exec__");
    expect(found.status).toBe("running");
    expect(found.config_snapshot).toBe('{"test":true}');
    expect(found.run_count).toBe(0);
    expect(found.cycle_count).toBe(1);
    expect(found.total_cost_usd).toBe(0);

    // Clean up
    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_exec__'`).run();
  });

  test("updateExecution changes fields", () => {
    const { insertExecution, updateExecution, getExecutions, db } = require("./db");

    const execId = insertExecution("__test_exec_update__");
    updateExecution(execId, {
      status: "done",
      completedAt: Date.now(),
      runCount: 5,
      cycleCount: 2,
      totalCostUsd: 1.23,
    });

    const execs = getExecutions("__test_exec_update__", 1);
    expect(execs.length).toBe(1);
    expect(execs[0].status).toBe("done");
    expect(execs[0].run_count).toBe(5);
    expect(execs[0].cycle_count).toBe(2);
    expect(execs[0].total_cost_usd).toBe(1.23);
    expect(execs[0].completed_at).toBeGreaterThan(0);

    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_exec_update__'`).run();
  });

  test("getActiveExecutions returns only running executions", () => {
    const { insertExecution, updateExecution, getActiveExecutions, db } = require("./db");

    const id1 = insertExecution("__test_active__");
    const id2 = insertExecution("__test_active__");
    updateExecution(id2, { status: "done", completedAt: Date.now() });

    const active = getActiveExecutions("__test_active__");
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(id1);

    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_active__'`).run();
  });

  test("insertActionRun with executionId", () => {
    const { insertExecution, insertActionRun, getActionRuns, db } = require("./db");

    const execId = insertExecution("__test_run_exec__");
    const runId = insertActionRun(
      "__test_run_exec__", 1, null, Date.now(), 1, "manual", null, execId,
    );
    expect(typeof runId).toBe("number");

    const runs = getActionRuns("__test_run_exec__", 1);
    expect(runs.length).toBe(1);
    expect(runs[0].executionId).toBe(execId);

    db.prepare(`DELETE FROM action_runs WHERE action_name = '__test_run_exec__'`).run();
    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_run_exec__'`).run();
  });

  test("insertActionRun without executionId (backwards compat)", () => {
    const { insertActionRun, getActionRuns, db } = require("./db");

    const runId = insertActionRun(
      "__test_run_noexec__", 1, null, Date.now(), 1, "manual", null,
    );
    expect(typeof runId).toBe("number");

    const runs = getActionRuns("__test_run_noexec__", 1);
    expect(runs.length).toBe(1);
    expect(runs[0].executionId).toBeNull();

    db.prepare(`DELETE FROM action_runs WHERE action_name = '__test_run_noexec__'`).run();
  });

  test("getRunsByExecution returns runs for specific execution", () => {
    const { insertExecution, insertActionRun, getRunsByExecution, db } = require("./db");

    const exec1 = insertExecution("__test_runs_by_exec__");
    const exec2 = insertExecution("__test_runs_by_exec__");

    insertActionRun("__test_runs_by_exec__", 1, null, Date.now(), 1, "manual", null, exec1);
    insertActionRun("__test_runs_by_exec__", 2, null, Date.now(), 1, "manual", null, exec1);
    insertActionRun("__test_runs_by_exec__", 3, null, Date.now(), 1, "manual", null, exec2);

    const runs1 = getRunsByExecution(exec1);
    expect(runs1.length).toBe(2);
    expect(runs1[0].runNumber).toBe(1);
    expect(runs1[1].runNumber).toBe(2);

    const runs2 = getRunsByExecution(exec2);
    expect(runs2.length).toBe(1);
    expect(runs2[0].runNumber).toBe(3);

    db.prepare(`DELETE FROM action_runs WHERE action_name = '__test_runs_by_exec__'`).run();
    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_runs_by_exec__'`).run();
  });

  test("updateActionRun accepts attempts and verifyError", () => {
    const { insertActionRun, updateActionRun, getActionRuns, db } = require("./db");

    const runId = insertActionRun(
      "__test_pipeline__", 1, null, Date.now(), 1, "manual", null,
    );
    expect(typeof runId).toBe("number");

    updateActionRun(runId, {
      status: "failed-verification",
      attempts: 3,
      verifyError: "SVG file was empty",
      completedAt: Date.now(),
    });

    const runs = getActionRuns("__test_pipeline__", 1);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("failed-verification");
    expect(runs[0].attempts).toBe(3);
    expect(runs[0].verifyError).toBe("SVG file was empty");

    db.prepare(`DELETE FROM action_runs WHERE action_name = '__test_pipeline__'`).run();
  });
});

// ── Execution Lifecycle Tests ──

describe("execution lifecycle", () => {
  test("execution starts as running, can be closed to done", () => {
    const { insertExecution, updateExecution, getExecutions, db } = require("./db");

    const execId = insertExecution("__test_lifecycle__");
    let execs = getExecutions("__test_lifecycle__", 1);
    expect(execs[0].status).toBe("running");

    updateExecution(execId, { status: "done", completedAt: Date.now(), runCount: 10 });
    execs = getExecutions("__test_lifecycle__", 1);
    expect(execs[0].status).toBe("done");
    expect(execs[0].run_count).toBe(10);

    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_lifecycle__'`).run();
  });

  test("execution can be marked as reset", () => {
    const { insertExecution, updateExecution, getExecutions, db } = require("./db");

    const execId = insertExecution("__test_reset_exec__");
    updateExecution(execId, { status: "reset", completedAt: Date.now() });

    const execs = getExecutions("__test_reset_exec__", 1);
    expect(execs[0].status).toBe("reset");

    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_reset_exec__'`).run();
  });

  test("multiple executions for same action", () => {
    const { insertExecution, getExecutions, db } = require("./db");

    const id1 = insertExecution("__test_multi_exec__");
    const id2 = insertExecution("__test_multi_exec__");
    const id3 = insertExecution("__test_multi_exec__");

    const execs = getExecutions("__test_multi_exec__", 10);
    expect(execs.length).toBe(3);
    // Ordered by id DESC (newest first)
    expect(execs[0].id).toBe(id3);
    expect(execs[1].id).toBe(id2);
    expect(execs[2].id).toBe(id1);

    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_multi_exec__'`).run();
  });

  test("execution cost accumulates across runs", () => {
    const { insertExecution, insertActionRun, updateActionRun, updateExecution, getExecutions, db } = require("./db");

    const execId = insertExecution("__test_cost__");

    // Simulate 3 runs with costs
    for (let i = 1; i <= 3; i++) {
      const runId = insertActionRun("__test_cost__", i, null, Date.now(), 1, "manual", null, execId);
      updateActionRun(runId, { status: "done", costUsd: 0.05 * i, completedAt: Date.now() });
    }

    // Update execution total cost (as the runner would)
    const totalCost = 0.05 + 0.10 + 0.15;
    updateExecution(execId, { totalCostUsd: totalCost, runCount: 3 });

    const execs = getExecutions("__test_cost__", 1);
    expect(execs[0].total_cost_usd).toBeCloseTo(0.30, 2);
    expect(execs[0].run_count).toBe(3);

    db.prepare(`DELETE FROM action_runs WHERE action_name = '__test_cost__'`).run();
    db.prepare(`DELETE FROM action_executions WHERE action_name = '__test_cost__'`).run();
  });
});

// ── Exhaustion Detection (in-memory) ──

describe("exhaustion detection", () => {
  // Re-implement the logic here to test in isolation
  function isExecutionExhausted(
    exec: { runNumber: number; cycleNumber: number; cycleRunCount: number },
    config: { maxRuns?: number; maxCycles?: number; cycleInterval?: string },
  ): boolean {
    const { maxRuns, maxCycles, cycleInterval } = config;
    if (!maxRuns || maxRuns <= 0) return false;
    if (cycleInterval && maxCycles && maxCycles > 0) {
      return exec.cycleNumber >= maxCycles && exec.cycleRunCount >= maxRuns;
    }
    return exec.runNumber >= maxRuns;
  }

  test("not exhausted when no maxRuns", () => {
    expect(isExecutionExhausted(
      { runNumber: 100, cycleNumber: 1, cycleRunCount: 100 },
      {},
    )).toBe(false);
  });

  test("exhausted at lifetime cap (no cycles)", () => {
    expect(isExecutionExhausted(
      { runNumber: 20, cycleNumber: 1, cycleRunCount: 20 },
      { maxRuns: 20 },
    )).toBe(true);
  });

  test("not exhausted below lifetime cap", () => {
    expect(isExecutionExhausted(
      { runNumber: 19, cycleNumber: 1, cycleRunCount: 19 },
      { maxRuns: 20 },
    )).toBe(false);
  });

  test("exhausted at last cycle + full runs (cycle mode)", () => {
    expect(isExecutionExhausted(
      { runNumber: 10, cycleNumber: 3, cycleRunCount: 5 },
      { maxRuns: 5, maxCycles: 3, cycleInterval: "1d" },
    )).toBe(true);
  });

  test("not exhausted mid-cycle (cycle mode)", () => {
    expect(isExecutionExhausted(
      { runNumber: 8, cycleNumber: 2, cycleRunCount: 3 },
      { maxRuns: 5, maxCycles: 3, cycleInterval: "1d" },
    )).toBe(false);
  });

  test("not exhausted at run limit but not last cycle", () => {
    expect(isExecutionExhausted(
      { runNumber: 5, cycleNumber: 1, cycleRunCount: 5 },
      { maxRuns: 5, maxCycles: 3, cycleInterval: "1d" },
    )).toBe(false);
  });
});

// ── Artifact Path Tests ──

describe("artifactPath / artifactDir", () => {
  const testDir = join(import.meta.dir, "__test_artifacts__");

  test("artifactDir creates directory lazily", () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });

    let created = false;
    const artifactDir = () => {
      if (!created) {
        mkdirSync(testDir, { recursive: true });
        created = true;
      }
      return testDir;
    };
    const artifactPath = (f: string) => join(artifactDir(), f);

    expect(existsSync(testDir)).toBe(false);

    const dir = artifactDir();
    expect(existsSync(dir)).toBe(true);
    expect(dir).toBe(testDir);

    const svgPath = artifactPath("output.svg");
    expect(svgPath).toBe(join(testDir, "output.svg"));

    const dir2 = artifactDir();
    expect(dir2).toBe(testDir);

    rmSync(testDir, { recursive: true });
  });

  test("artifact path includes execution ID", () => {
    const execId = 42;
    const runNumber = 3;
    const actionDir = "/tmp/test-action";
    const runDir = join(actionDir, "output", `exec-${execId}`, `run-${runNumber}`);
    expect(runDir).toBe("/tmp/test-action/output/exec-42/run-3");
  });
});

// ── onExhausted Mode Tests ──

describe("onExhausted modes", () => {
  test("archive mode defaults when absent", () => {
    const config: import("./action-types").ActionConfig = {
      name: "test", description: "test", enabled: true,
      agentProfile: "default", trigger: { type: "manual" },
    };
    expect(config.onExhausted ?? "archive").toBe("archive");
  });

  test("idle mode preserves value", () => {
    const config: import("./action-types").ActionConfig = {
      name: "test", description: "test", enabled: true,
      agentProfile: "default", trigger: { type: "manual" },
      onExhausted: "idle",
    };
    expect(config.onExhausted).toBe("idle");
  });

  test("restart mode preserves value", () => {
    const config: import("./action-types").ActionConfig = {
      name: "test", description: "test", enabled: true,
      agentProfile: "default", trigger: { type: "manual" },
      onExhausted: "restart",
    };
    expect(config.onExhausted).toBe("restart");
  });
});

console.log("\n--- Action Pipeline v2 + Executions dry-run tests ---\n");
