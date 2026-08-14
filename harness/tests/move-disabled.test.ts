import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { activateMove, attachMove, listMoves } from "../move-runner";

/**
 * `enabled: false` is the off switch for a move, and it has to hold on every
 * entry point or it is not one. It used to hold on discovery and activation but
 * not on attach — a page embed or client extension could still mint a live API
 * token for a move the user had switched off, with nothing in any picker to
 * explain where the behavior was coming from.
 *
 * Note the default is the opposite of an action's: an absent `enabled` means a
 * move is on (`config.enabled !== false`), while `ActionConfig.enabled` is
 * required and an action must say `true` to run.
 */

const projectRoot = mkdtempSync(join(tmpdir(), "modus-move-disabled-"));

function writeMove(name: string, enabled: boolean | undefined) {
  const dir = join(projectRoot, ".modus", "moves", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "move.json"), JSON.stringify({
    name,
    label: `Fixture ${name}`,
    mode: "inline",
    ...(enabled === undefined ? {} : { enabled }),
    submit: { required: false },
    widget: { label: "Fixture", mountOnAttach: true },
    api: { ops: [{ name: "ping", description: "ping" }] },
  }));
  writeFileSync(join(dir, "context.ts"), [
    "export const handlers = { ping: async () => ({ ok: true }) };",
    "export async function gather() { return 'fixture'; }",
  ].join("\n"));
}

writeMove("off-fixture", false);
writeMove("on-fixture", true);
writeMove("default-fixture", undefined);

afterAll(() => {
  if (projectRoot.startsWith(tmpdir())) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("a disabled move is off on every entry point", () => {
  test("discovery hides it", () => {
    const names = listMoves(projectRoot).map((move) => move.name);
    expect(names).toContain("on-fixture");
    expect(names).not.toContain("off-fixture");
  });

  test("activation refuses it", async () => {
    const result = await activateMove({ moveName: "off-fixture", inputs: {}, cwd: projectRoot });
    expect(result).toEqual({ error: "Move is disabled: off-fixture" });
  });

  // The gap this test exists for: attach mints an API token, so letting it
  // through made `enabled: false` advisory rather than an off switch.
  test("attach refuses it rather than minting a token", async () => {
    const result = await attachMove({ moveName: "off-fixture", inputs: {}, cwd: projectRoot });
    expect(result).toEqual({ error: "Move is disabled: off-fixture" });
  });

  test("attach still works for an enabled move, so the guard is not blanket", async () => {
    const result = await attachMove({ moveName: "on-fixture", inputs: {}, cwd: projectRoot });
    expect("error" in result ? result.error : null).toBeNull();
    expect("apiToken" in result ? result.apiToken : "").toStartWith("mapi-");
  });
});

describe("an absent enabled means on", () => {
  test("discovery lists it", () => {
    expect(listMoves(projectRoot).map((move) => move.name)).toContain("default-fixture");
  });

  test("attach mints a token for it", async () => {
    const result = await attachMove({ moveName: "default-fixture", inputs: {}, cwd: projectRoot });
    expect("apiToken" in result ? result.apiToken : "").toStartWith("mapi-");
  });
});
