import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Command operations use manual, webhook, session, interval, chain, cancellation, and restart lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "modus-operation-runner-"));
  const env = {
    ...process.env, NODE_ENV: "production", MODUS_INSTANCE: "default", MODUS_VAULT_ROOT: "",
    MODUS_HOME: join(root, "home"), MODUS_RESOURCES_DIR: join(root, "resources"),
    MODUS_CONFIG_DIR: join(root, "config"), MODUS_DATA_DIR: join(root, "data"),
    MODUS_LOGS_DIR: join(root, "logs"), MODUS_RUNTIME_DIR: join(root, "runtime"), MODUS_CACHE_DIR: join(root, "cache"),
    HARNESS_SECRETS_FILE: join(root, "secrets.env"), MODUS_SKIP_STARTUP_MAINTENANCE: "0",
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"),
  };
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, ...args], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status, stderr).toBe(0);
    return JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith("RESULT:"))!.slice(7));
  };
  try {
    const result = await invoke([join(import.meta.dir, "fixtures", "action-operation-runner-driver.ts")]);
    expect(result.accepted).toBe(true);
    expect(result.overlap).toBe(false);
    expect(result.invalidRejected).toBe(true);
    expect(result.manual.sessionId).toBeNull();
    expect(result.manual.operation.stdout).toContain("web");
    expect(result.manual.status).toBe("done");
    expect(result.chain.operation.parentRunId).toBe(result.manual.id);
    expect(result.chain.status).toBe("done");
    expect(result.invalidHook.ok).toBe(false);
    expect(result.validHook.ok).toBe(true);
    expect(result.webhook.operation.inputs).toEqual({ count: 1 });
    expect(result.session.status).toBe("done");
    expect(result.denied.error).toContain("shell: false");
    expect(result.denied.operation.stdout).toBe("");
    expect(result.handoff.status).toBe("done");
    expect(result.handoffTarget.operation.parentRunId).toBe(result.handoff.id);
    expect(result.handoffTarget.operation.inputs).toEqual({ text: "recorded-output" });
    expect(result.interval.status).toBe("done");
    expect(result.cancelled).toBe(true);
    expect(result.resetWhileBusy).toBe(false);
    expect(result.cancellation.operation.outcome).toBe("cancelled");
    expect(result.badConfigLoaded).toBe(false);
    expect(result.loadErrors[0].name).toBe("bad-config");
    const restarted = await invoke(["-e", "const db = await import('./db'); console.log('RESULT:' + JSON.stringify(db.getActionRuns('restart')[0])); process.exit(0)"]);
    expect(restarted.operation.outcome).toBe("interrupted");
    expect(restarted.status).toBe("error");
    expect(restarted.completedAt).not.toBeNull();
    await Bun.sleep(2800);
    expect(existsSync(join(root, "resources", "orphan-leaked"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
