import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  activateMove, attachMove, buildStateApi, deactivateAmbientMove, detachMove,
  getActiveAmbientMoves, getInstanceStore, setInstanceStore,
} from "../move-runner";

const root = mkdtempSync(join(tmpdir(), "modus-move-cleanup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string, persistent = false) {
  const dir = join(root, ".modus", "moves", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "move.json"), JSON.stringify({
    name, label: name, description: "State cleanup fixture", persistent,
    api: { ops: { ping: { description: "ping" } } },
    widget: { component: "widget.tsx", label: name, mountOnAttach: true },
  }));
  writeFileSync(join(dir, "context.ts"), 'export const handlers = { ping: async () => ({ ok: true }) }; export const gather = async () => "fixture";');
}

test("detaching releases in-memory state and store without deleting persisted state", async () => {
  const name = "cleanup-attached";
  fixture(name);
  const attached = await attachMove({ moveName: name, cwd: root });
  if ("error" in attached) throw new Error(attached.error);
  const state = buildStateApi(attached.instanceId, name, root, false);
  await state.set({ payload: "retained object" });
  setInstanceStore(attached.instanceId, { payload: "stored object" });
  const persisted = buildStateApi(attached.instanceId, name, root, true);
  await persisted.set({ durable: true });
  expect(detachMove(attached.apiToken)).toBe(true);
  expect(await state.get()).toBeUndefined();
  expect(getInstanceStore(attached.instanceId)).toBeUndefined();
  expect(await persisted.get()).toEqual({ durable: true });
});

test("deactivating an ambient API move releases its state and process store", async () => {
  const name = "cleanup-ambient";
  fixture(name, true);
  const sessionId = "cleanup-session";
  const activated = await activateMove({ moveName: name, cwd: root, sessionId });
  if ("error" in activated) throw new Error(activated.error);
  const instanceId = getActiveAmbientMoves(sessionId).find((move) => move.moveName === name)!.instanceId!;
  const state = buildStateApi(instanceId, name, root, false);
  await state.set({ payload: "retained object" });
  setInstanceStore(instanceId, { payload: "stored object" });
  expect(deactivateAmbientMove(sessionId, name)).toBe(true);
  expect(await state.get()).toBeUndefined();
  expect(getInstanceStore(instanceId)).toBeUndefined();
});
