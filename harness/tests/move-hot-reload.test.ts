import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { attachMove, detachMove, handleMoveApiSubmit } from "../move-runner";

const projectRoot = mkdtempSync(join(tmpdir(), "modus-move-reload-"));
const moveDir = join(projectRoot, ".modus", "moves", "reload-fixture");
mkdirSync(moveDir, { recursive: true });

writeFileSync(join(moveDir, "move.json"), JSON.stringify({
  name: "reload-fixture",
  label: "Reload fixture",
  description: "Exercises move-local module reloads",
  api: { ops: { probe: { description: "Read the sibling module value" } } },
  widget: { component: "widget.tsx", label: "Reload", mountOnAttach: true },
}));
writeFileSync(join(moveDir, "context.ts"), [
  'import { currentValue } from "./value";',
  "export const handlers = {",
  "  probe: async (ctx: any) => {",
  '    ctx.emit({ type: "state-changed" });',
  '    return { ok: true, value: currentValue, hasEmit: typeof ctx.emit === "function" };',
  "  },",
  "};",
].join("\n"));
writeFileSync(join(moveDir, "value.ts"), 'export const currentValue = "first";\n');

afterAll(() => rmSync(projectRoot, { recursive: true, force: true }));

describe("move module hot reload", () => {
  test("re-attaching reloads move-local sibling imports and exposes widget emit", async () => {
    const firstAttach = await attachMove({ moveName: "reload-fixture", inputs: {}, cwd: projectRoot });
    if ("error" in firstAttach) throw new Error(firstAttach.error);
    const first = await handleMoveApiSubmit(firstAttach.apiToken, { op: "probe" });
    expect(first).toMatchObject({ ok: true, value: "first", hasEmit: true });

    expect(detachMove(firstAttach.apiToken)).toBe(true);
    writeFileSync(join(moveDir, "value.ts"), 'export const currentValue = "second";\n');

    const secondAttach = await attachMove({ moveName: "reload-fixture", inputs: {}, cwd: projectRoot });
    if ("error" in secondAttach) throw new Error(secondAttach.error);
    const second = await handleMoveApiSubmit(secondAttach.apiToken, { op: "probe" });
    expect(second).toMatchObject({ ok: true, value: "second", hasEmit: true });
    detachMove(secondAttach.apiToken);
  });

  test("concurrent activation paths share an in-flight module import", async () => {
    const [left, right] = await Promise.all([
      attachMove({ moveName: "reload-fixture", inputs: { instanceId: "left" }, cwd: projectRoot }),
      attachMove({ moveName: "reload-fixture", inputs: { instanceId: "right" }, cwd: projectRoot }),
    ]);
    if ("error" in left) throw new Error(left.error);
    if ("error" in right) throw new Error(right.error);
    expect((await handleMoveApiSubmit(left.apiToken, { op: "probe" })).ok).toBe(true);
    expect((await handleMoveApiSubmit(right.apiToken, { op: "probe" })).ok).toBe(true);
    detachMove(left.apiToken);
    detachMove(right.apiToken);
  });
});
