import { strict as assert } from "node:assert";
import { Hono } from "hono";
import { memoryGuardApi } from "../../memory-guard-api";
import { canSpawnSession, getMemoryStatus, resolveReapLimits, setMaxConcurrentSessions } from "../../memory-guard";

const scenario = process.argv[2];
const app = new Hono().route("/api/system/memory", memoryGuardApi);
const update = (body: unknown) => app.request("/api/system/memory", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

if (scenario === "live") {
  const limits = resolveReapLimits();
  const initial = getMemoryStatus();
  assert.equal(initial.maxConcurrentSessions, 6);
  assert.equal(canSpawnSession(6).ok, false);
  const response = await update({ maxConcurrentSessions: 10 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).maxConcurrentSessions, 10);
  assert.equal(canSpawnSession(6).ok, true);
  assert.equal(canSpawnSession(9).ok, true);
  assert.equal(canSpawnSession(10).ok, false);
  assert.equal((await (await app.request("/api/system/memory")).json()).maxConcurrentSessions, 10);

  // Lowering affects admission only; resource/reclamation policies stay unchanged.
  assert.equal((await update({ maxConcurrentSessions: 2 })).status, 200);
  assert.equal(canSpawnSession(6).ok, false);
  assert.equal(canSpawnSession(1).ok, true);
  assert.deepEqual(resolveReapLimits(), limits);
  const current = getMemoryStatus();
  for (const key of ["pressureThreshold", "pressureBlockingEnabled", "maxHeapPerProcessMB", "watchdogRunning"] as const) {
    assert.equal(current[key], initial[key]);
  }
  assert.equal(current.concurrencyLimitMutable, true);
} else if (scenario === "invalid") {
  setMaxConcurrentSessions(10);
  for (const value of [0, -1, 1.5, "12", null, true, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => setMaxConcurrentSessions(value), /positive safe integer/);
    assert.equal((await update({ maxConcurrentSessions: value })).status, 400);
    assert.equal(getMemoryStatus().maxConcurrentSessions, 10);
  }
  for (const body of [null, [], 10, {}, { maxConcurrentSessions: 12, pressureBlockingEnabled: false }]) {
    assert.equal((await update(body)).status, 400);
  }
  assert.equal((await app.request("/api/system/memory", { method: "PUT", body: "{" })).status, 400);
  assert.equal(getMemoryStatus().maxConcurrentSessions, 10);
} else if (scenario === "pressure") {
  setMaxConcurrentSessions(10);
  const result = canSpawnSession(6);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /system memory pressure/);
} else {
  assert.equal(getMemoryStatus().maxConcurrentSessions, Number(scenario));
}
