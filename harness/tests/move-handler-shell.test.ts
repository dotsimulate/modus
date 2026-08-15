import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gatherMoveOnce, handleMoveApiSubmit } from "../move-runner";
import { createTestMoveApiContext } from "../move-test-context";

const projectRoot = mkdtempSync(join(tmpdir(), "modus-handler-shell-"));

/**
 * A move whose only op reports what `ctx.shell.run` did — returning the failure
 * rather than throwing, so the gate's own message is what the test asserts on.
 */
function writeShellMove(name: string, config: Record<string, unknown>): void {
  const dir = join(projectRoot, ".modus", "moves", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "move.json"), JSON.stringify({
    name,
    label: name,
    api: { tokenPrefix: name, ops: { sh: { description: "Run a command." } } },
    ...config,
  }));
  writeFileSync(join(dir, "context.ts"), [
    "export async function gather() { return 'shell fixture'; }",
    "export const handlers = {",
    "  sh: async (ctx: any, data: any) => {",
    "    try {",
    "      return { ok: true, out: await ctx.shell.run(data.cmd) };",
    "    } catch (err: any) {",
    "      return { ok: false, error: String(err?.message ?? err) };",
    "    }",
    "  },",
    "};",
  ].join("\n"));
}

afterAll(() => {
  if (projectRoot.startsWith(tmpdir())) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("handler shell", () => {
  test("a reviewed move that declared shell: false is blocked before spawning", async () => {
    const name = "shell-denied";
    writeShellMove(name, { trust: "reviewed", capabilities: { shell: false } });

    const gathered = await gatherMoveOnce(name, "", projectRoot, undefined, {});
    const result = await handleMoveApiSubmit(gathered!.apiToken!, {
      op: "sh",
      cmd: "echo should-never-run",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("capabilities.shell: false");
    expect(result.error).toContain(name);
    // The gate refuses before the command exists as a process, so no output.
    expect(result.out).toBeUndefined();
  });

  // Experimental is the default tier for a project move. Denial is audited but
  // not enforced there, which is the tier's whole contract — a handler that
  // needs its shell blocked has to be declared `reviewed`.
  test("an experimental move is audited, not blocked", async () => {
    const name = "shell-experimental";
    writeShellMove(name, { capabilities: { shell: false } });

    const gathered = await gatherMoveOnce(name, "", projectRoot, undefined, {});
    const result = await handleMoveApiSubmit(gathered!.apiToken!, {
      op: "sh",
      cmd: "echo handler-shell-ran",
    });

    // This also proves the member is live rather than merely declared: the
    // command really was spawned through the Harness Context's shell.
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.out).toBe("handler-shell-ran");
  });
});

describe("test context shell", () => {
  test("an unstubbed command throws and names the factory", async () => {
    const { ctx } = createTestMoveApiContext({ moveName: "probe" });
    expect(ctx.shell.run("ls")).rejects.toThrow("createTestMoveApiContext");
  });

  test("a stubbed command is recorded", async () => {
    const { ctx, commands } = createTestMoveApiContext({
      moveName: "probe",
      run: async (cmd) => `ran: ${cmd}`,
    });

    expect(await ctx.shell.run("git status")).toBe("ran: git status");
    expect(commands).toEqual(["git status"]);
  });

  test("commands are recorded even when an override supplies the shell", async () => {
    const { ctx, commands } = createTestMoveApiContext({
      moveName: "probe",
      overrides: { shell: { run: async () => "from override" } },
    });

    expect(await ctx.shell.run("whoami")).toBe("from override");
    expect(commands).toEqual(["whoami"]);
  });
});
