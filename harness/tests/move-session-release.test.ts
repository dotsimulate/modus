import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { upsertSession } from "../db";
import {
  attachMove, buildStateApi, detachMove, getActiveWidgetForSession, getInstanceStore, handleMoveApiSubmit,
  recoverSessionMoveApis, releaseSessionMoveApis, setInstanceStore,
} from "../move-runner";
import { moveRegistryPath } from "../move-runtime-root";

const root = mkdtempSync(join(tmpdir(), "modus-move-release-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string, widget: boolean) {
  const dir = join(root, ".modus", "moves", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "move.json"), JSON.stringify({
    name, label: name, description: "Session release fixture",
    api: { state: { persist: false }, ops: { ping: { description: "ping" } } },
    widget: { component: widget ? "widget.tsx" : undefined, label: name, mountOnAttach: true },
  }));
  writeFileSync(join(dir, "context.ts"), 'export const handlers = { ping: async () => ({ ok: true, message: "pong" }) };');
}

async function attachForSession(name: string) {
  const sessionId = `release-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "release fixture", messageCount: 0, costUsd: 0, cwd: root });
  const attached = await attachMove({ moveName: name, cwd: root, sessionId });
  if ("error" in attached) throw new Error(attached.error);
  return { sessionId, ...attached };
}

test("releasing a session evicts its registration and memory but keeps the token recoverable", async () => {
  const name = "release-recoverable";
  fixture(name, true);
  const { sessionId, apiToken, instanceId } = await attachForSession(name);
  await buildStateApi(instanceId, name, root, false).set({ payload: "in memory only" });
  setInstanceStore(instanceId, { payload: "stored object" });
  expect(getActiveWidgetForSession(sessionId)).toHaveLength(1);

  expect(releaseSessionMoveApis(sessionId)).toBe(1);
  expect(getActiveWidgetForSession(sessionId)).toHaveLength(0);
  expect(getInstanceStore(instanceId)).toBeUndefined();
  expect(await buildStateApi(instanceId, name, root, false).get()).toBeUndefined();
  // The persisted row is what makes the eviction safe.
  const registry = JSON.parse(readFileSync(moveRegistryPath(root, name), "utf8"));
  expect(registry[apiToken]).toMatchObject({ instanceId, sessionId });

  // A later call recovers the token on demand, as after a restart.
  expect(await handleMoveApiSubmit(apiToken, { op: "ping" })).toMatchObject({ ok: true, message: "pong" });
  expect(detachMove(apiToken)).toBe(true);
});

test("widget restore recovers a released session's widget moves without re-pinning other tokens", async () => {
  const widgetMove = "release-widget";
  const plainMove = "release-plain";
  fixture(widgetMove, true);
  fixture(plainMove, false);
  const sessionId = `release-${crypto.randomUUID()}`;
  upsertSession({ id: sessionId, preview: "release fixture", messageCount: 0, costUsd: 0, cwd: root });
  const widget = await attachMove({ moveName: widgetMove, cwd: root, sessionId });
  const plain = await attachMove({ moveName: plainMove, cwd: root, sessionId });
  if ("error" in widget) throw new Error(widget.error);
  if ("error" in plain) throw new Error(plain.error);

  expect(releaseSessionMoveApis(sessionId)).toBe(2);
  expect(await recoverSessionMoveApis(sessionId, { onlyWidgetMoves: true })).toBe(1);
  expect(getActiveWidgetForSession(sessionId).map((entry) => entry.apiToken)).toEqual([widget.apiToken]);
  // Recovery does not replace a registration that is already live.
  expect(await recoverSessionMoveApis(sessionId, { onlyWidgetMoves: true })).toBe(0);
  // The plain move was left on disk, not reloaded; releasing again finds only the widget.
  expect(releaseSessionMoveApis(sessionId)).toBe(1);
});

test("releasing an unrelated or empty session id releases nothing", async () => {
  const name = "release-unrelated";
  fixture(name, true);
  const { sessionId, apiToken } = await attachForSession(name);
  expect(releaseSessionMoveApis("")).toBe(0);
  expect(releaseSessionMoveApis(`other-${crypto.randomUUID()}`)).toBe(0);
  expect(getActiveWidgetForSession(sessionId)).toHaveLength(1);
  expect(detachMove(apiToken)).toBe(true);
});
