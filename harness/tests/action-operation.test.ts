import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { executeOperation, operationCapacityAvailable } from "../action-operation";
import { operationConfigError, validateActionInputs } from "../action-operation-config";
import type { ActionConfig } from "../action-types";
import type { OperationReceipt } from "../action-operation-types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(code?: string) {
  const root = mkdtempSync(join(tmpdir(), "modus-operation-"));
  roots.push(root);
  if (code) writeFileSync(join(root, "context.ts"), code);
  const controller = new AbortController();
  const config: ActionConfig = {
    name: "test", description: "", enabled: true, trigger: { type: "manual" }, cwd: root,
    timeoutMs: 8_000,
    execution: code ? { type: "code" } : { type: "command", executable: process.execPath, args: ["-e", "console.log('hello'); console.error('diagnostic')"] },
  };
  const snapshots: OperationReceipt[] = [];
  return { root, controller, config, snapshots, run: (overrides: Partial<Parameters<typeof executeOperation>[0]> = {}) => executeOperation({
    config, actionDir: root, runId: 1, inputs: {}, trigger: { type: "manual" }, controller,
    onUpdate: receipt => snapshots.push(structuredClone(receipt)),
    assertShell() {}, request: async () => { throw new Error("Unexpected capability request"); }, ...overrides,
  }) };
}

test("command succeeds without a context file and stderr is diagnostic", async () => {
  const job = setup();
  const { receipt } = await job.run();
  expect(receipt.outcome).toBe("succeeded");
  expect(receipt.exitCode).toBe(0);
  expect(receipt.stdout).toContain("hello");
  expect(receipt.stderr).toContain("diagnostic");
  expect(receipt.command?.shell).toBe(false);
  expect(job.snapshots[0]?.outcome).toBe("running");
}, 15_000);

test("missing executable and nonzero exit have different receipts", async () => {
  const missing = setup();
  missing.config.execution = { type: "command", executable: join(missing.root, "missing-executable") };
  expect((await missing.run()).receipt.outcome).toBe("could-not-start");
  const failed = setup();
  failed.config.execution = { type: "command", executable: process.execPath, args: ["-e", "process.exit(7)"] };
  const result = await failed.run();
  expect(result.receipt.outcome).toBe("failed");
  expect(result.receipt.exitCode).toBe(7);
}, 15_000);

test("code returns structured output and rejects failed managed processes by default", async () => {
  const job = setup(`export async function run(ctx) {
    const result = await ctx.process.run({ executable: ${JSON.stringify(process.execPath)}, args: ['-e', 'process.exit(9)'] });
    return { summary: 'should not succeed', data: result };
  }`);
  const result = await job.run();
  expect(result.receipt.outcome).toBe("failed");
  expect(result.error).toContain("ProcessExitError");
  const inspect = setup(`export async function run(ctx) {
    const result = await ctx.process.run({ executable: ${JSON.stringify(process.execPath)}, args: ['-e', 'process.exit(9)'], check: false });
    return { summary: 'inspected', data: { exitCode: result.exitCode } };
  }`);
  const inspected = await inspect.run();
  expect(inspected.receipt.outcome).toBe("succeeded");
  expect(inspected.receipt.result?.data).toEqual({ exitCode: 9 });
}, 20_000);

test("exceptions, process.exit, and synchronous loops remain inside the worker", async () => {
  for (const code of ["throw new Error('bad task')", "process.exit(23)", "while (true) {}"] ) {
    const job = setup(`export async function run() { ${code} }`);
    job.config.timeoutMs = code.startsWith("while") ? 800 : 5_000;
    const healthy = setup();
    const [result, other] = await Promise.all([job.run(), healthy.run()]);
    expect(result.receipt.outcome).toBe(code.startsWith("while") ? "timed-out" : "failed");
    expect(other.receipt.outcome).toBe("succeeded");
    expect(operationCapacityAvailable()).toBe(true);
  }
}, 25_000);

test("noisy output has a bounded tail and truncation is visible", async () => {
  const job = setup();
  job.config.execution = { type: "command", executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(2_000_000) + 'END')"] };
  const { receipt } = await job.run();
  expect(receipt.outcome).toBe("succeeded");
  expect(receipt.stdout.endsWith("END")).toBe(true);
  expect(Buffer.byteLength(receipt.stdout)).toBeLessThanOrEqual(32 * 1024);
  expect(receipt.truncated).toBe(true);
}, 15_000);

test("cancellation kills descendants and keeps the slot until cleanup", async () => {
  const job = setup();
  const marker = join(job.root, "should-not-exist");
  const descendant = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 2500); setInterval(() => {}, 1000)`;
  job.config.execution = { type: "command", executable: process.execPath, args: ["-e", `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore', windowsHide: true }); console.log('ready'); setInterval(() => {}, 1000)`] };
  const running = job.run();
  await new Promise(r => setTimeout(r, 700));
  job.controller.abort();
  const result = await running;
  expect(result.receipt.stdout).toContain("ready");
  expect(result.receipt.outcome).toBe("cancelled");
  await new Promise(r => setTimeout(r, 2600));
  expect(existsSync(marker)).toBe(false);
}, 15_000);

test("global capacity rejects excess work without an unbounded waiting queue", async () => {
  const jobs = Array.from({ length: 5 }, () => setup("export async function run() { await new Promise(r => setTimeout(r, 500)); return { summary: 'done' }; }"));
  const results = await Promise.all(jobs.map(job => job.run()));
  expect(results.filter(r => r.receipt.outcome === "skipped")).toHaveLength(1);
  expect(results.filter(r => r.receipt.outcome === "succeeded")).toHaveLength(4);
}, 15_000);

test("input contract rejects invalid calls and keeps shell interpolation explicit", () => {
  const schema = { type: "object" as const, properties: { target: { type: "string" as const, enum: ["web", "desktop"] }, count: { type: "integer" as const, minimum: 1, default: 2 } }, required: ["target"] };
  expect(validateActionInputs(schema, { target: "web" })).toEqual({ target: "web", count: 2 });
  expect(() => validateActionInputs(schema, { target: "web", extra: true })).toThrow("Unknown");
  expect(() => validateActionInputs(schema, { target: "shell; bad" })).toThrow("choice");
  expect(() => validateActionInputs(schema, {})).toThrow("Missing");
  expect(() => validateActionInputs(schema, { target: "web", count: 1.2 })).toThrow("integer");
  const job = setup();
  expect(operationConfigError(job.config)).toBeNull();
  job.config.agentProfile = "dummy";
  expect(operationConfigError(job.config)).toContain("agentProfile");
  delete job.config.agentProfile;
  job.config.execution = { type: "command", executable: "echo", shell: true, args: ["bad"] };
  expect(operationConfigError(job.config)).toContain("Shell scripts");
});

test("secrets are resolved at execution time and redacted from logs and structured results", async () => {
  const secret = 'fixture-"quoted"-secret';
  const job = setup(`export async function run(ctx) {
    const value = await ctx.secrets.resolve('fixture');
    console.log(value); console.error(process.env.FIXTURE_SECRET);
    return { summary: value, data: { value } };
  }`);
  job.config.env = { FIXTURE_SECRET: { secret: "fixture" } };
  const { receipt } = await job.run({ request: async () => secret });
  expect(receipt.outcome).toBe("succeeded");
  expect(receipt.result?.data).toEqual({ value: "[redacted]" });
  expect(receipt.stdout).toContain("[redacted]");
  expect(receipt.stderr).toContain("[redacted]");
  expect(JSON.stringify([receipt, ...job.snapshots])).not.toContain("quoted");
}, 15_000);

test("required artifacts are validated before success and missing files fail", async () => {
  const job = setup(`import { writeFileSync } from 'fs';
    export async function run(ctx) {
      const path = ctx.artifacts.path('report.txt');
      writeFileSync(path, 'report');
      return { artifacts: [{ name: 'report', path, mime: 'text/plain' }] };
    }`);
  job.config.artifacts = [{ name: "report", mime: "text/plain" }];
  const success = await job.run();
  expect(success.receipt.outcome).toBe("succeeded");
  expect(existsSync(success.receipt.result!.artifacts![0]!.path)).toBe(true);
  const missing = setup("export async function run() { return { summary: 'forgot the artifact' }; }");
  missing.config.artifacts = [{ name: "report", mime: "text/plain" }];
  expect((await missing.run()).error).toContain("Required artifact");
}, 15_000);

test("input references are a single literal argument and oversized results fail", async () => {
  const job = setup();
  job.config.execution = { type: "command", executable: process.execPath, args: ["-e", "console.log(process.argv[1])", { input: "value" }] };
  const value = "spaces ; & $(literal)";
  const result = await job.run({ inputs: { value } });
  expect(result.receipt.stdout.trim()).toBe(value);
  const oversized = setup("export async function run() { return { data: 'x'.repeat(300000) }; }");
  const failed = await oversized.run();
  expect(failed.receipt.outcome).toBe("failed");
  expect(failed.error).toContain("exceeds");
}, 15_000);

test("bundled executor finds its staged guardian and runs a TypeScript code action", async () => {
  const job = setup("export async function run() { const value: number = 42; return { data: value }; }");
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "action-operation.ts"), join(import.meta.dir, "..", "action-worker.ts")],
    outdir: job.root, target: "bun", naming: "[name].js",
  });
  expect(built.success).toBe(true);
  const bundled = await import(pathToFileURL(join(job.root, "action-operation.js")).href);
  const result = await bundled.executeOperation({ config: job.config, actionDir: job.root, runId: 1, inputs: {}, trigger: { type: "manual" }, controller: job.controller, onUpdate() {}, assertShell() {}, request: async () => undefined });
  expect(result.receipt.outcome).toBe("succeeded");
  expect(result.receipt.result.data).toBe(42);
}, 15_000);
