import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.MODUS_RESOURCES_DIR!;
const code = (text: string) => ({ type: "command", executable: process.execPath, args: ["-e", text] });
function action(name: string, config: Record<string, unknown>) {
  const dir = join(root, "actions", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "action.json"), JSON.stringify({ name, execution: code("console.log('ok')"), ...config }));
}
action("manual", { enabled: false, inputSchema: { type: "object", properties: { target: { type: "string", enum: ["web"] } }, required: ["target"] }, execution: { type: "command", executable: process.execPath, args: ["-e", "console.log(process.argv[1])", { input: "target" }] } });
action("chain", { trigger: { type: "action", source: "manual", condition: "done" } });
action("webhook", { trigger: { type: "webhook", token: "fixture-only" }, inputSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"] } });
action("session", { trigger: { type: "session", on: "archived" } });
action("interval", { trigger: { type: "interval", every: "1s" }, enabled: false });
action("cancel", { execution: code("setInterval(() => {}, 1000)") });
action("bad-config", { execution: { type: "command" } });
action("denied", { trust: "reviewed", capabilities: { shell: false } });
action("handoff-target", { inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
action("handoff", { execution: { type: "code" } });
writeFileSync(join(root, "actions", "handoff", "context.ts"), `export async function run(ctx) { await ctx.actions.trigger('handoff-target', { text: 'recorded-output' }); return { summary: 'handed off' }; }`);
action("restart", { execution: code(`console.log('started'); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(join(root, "orphan-leaked"))}, 'leaked'), 2500); setInterval(() => {}, 1000)`) });
const runner = await import("../../action-runner");
const db = await import("../../db");
runner.initActions();
async function finished(name: string, count = 1) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const runs = db.getActionRuns(name);
    if (runs.length >= count && runs.every(run => run.status !== "running")) return runs;
    await Bun.sleep(25);
  }
  throw new Error(`Run did not finish: ${name}`);
}
let invalidRejected = false;
try { await runner.triggerAction("manual", { inputs: { target: "invalid" } }); } catch { invalidRejected = true; }
const accepted = await runner.triggerAction("manual", { inputs: { target: "web" } });
const overlap = await runner.triggerAction("manual", { inputs: { target: "web" } });
const manual = (await finished("manual"))[0]!;
const chain = (await finished("chain"))[0]!;
const invalidHook = await runner.handleWebhook("webhook", "fixture-only", { count: 0 });
const validHook = await runner.handleWebhook("webhook", "fixture-only", { count: 1 });
const webhook = (await finished("webhook"))[0]!;
runner.onSessionEvent("archived", { id: "fixture-session", tags: [], preview: "", messageCount: 0 });
const session = (await finished("session"))[0]!;
await runner.triggerAction("denied");
const denied = (await finished("denied"))[0]!;
await runner.triggerAction("handoff");
const handoff = (await finished("handoff"))[0]!;
const handoffTarget = (await finished("handoff-target"))[0]!;
// Exercise the real timer loop with an already-due action, without starting a server.
const intervalState = runner.getActionState("interval")!;
intervalState.config.enabled = true;
intervalState.nextRunAt = Date.now() - 1;
const interval = (await finished("interval"))[0]!;
intervalState.config.enabled = false;
await runner.triggerAction("cancel");
const executionId = [...runner.getActionState("cancel")!.activeExecutions.keys()][0]!;
await Bun.sleep(300);
const cancelled = runner.cancelExecution("cancel", executionId);
const resetWhileBusy = runner.resetAction("cancel");
const cancellation = (await finished("cancel"))[0]!;
runner.stopActions();
// Abruptly end this isolated harness owner during real work. The guardian must
// reap the child, and the next process must reconcile the unfinished receipt.
await runner.triggerAction("restart");
await Bun.sleep(500);
console.log("RESULT:" + JSON.stringify({ accepted, overlap, invalidRejected, manual, chain, invalidHook, validHook, webhook, session, interval, cancelled, resetWhileBusy, cancellation, denied, handoff, handoffTarget, badConfigLoaded: !!runner.getActionState("bad-config"), loadErrors: runner.getActionLoadErrors() }));
process.exit(0);
