import { expect, test } from "bun:test";
import { join } from "node:path";

async function run(scenario: string, overrides: Record<string, string> = {}) {
  // A fresh process isolates module-level environment settings from other tests.
  // The driver imports only the guard and in-memory HTTP router; no providers or DB.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MG_")));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/memory-guard-driver.ts"), scenario], {
    env: { ...env, MG_BLOCK_ON_PRESSURE: "0", ...overrides }, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
}

test("defaults to ten and preserves valid startup overrides", async () => {
  await run("10");
  await run("14", { MG_MAX_CONCURRENT: "14" });
});

test("invalid startup values cannot disable the concurrency guard", async () => {
  for (const value of ["0", "-1", "NaN", "Infinity", "1.5", ""]) {
    await run("10", { MG_MAX_CONCURRENT: value });
  }
});

test("HTTP updates immediately raise and lower admission limits without changing reclamation", async () => {
  await run("live", { MG_MAX_CONCURRENT: "6" });
});

test("invalid HTTP payloads and setter values preserve the current limit", async () => {
  await run("invalid");
});

test("raising concurrency leaves memory-pressure blocking in force", async () => {
  await run("pressure", { MG_BLOCK_ON_PRESSURE: "1", MG_PRESSURE_THRESHOLD: "0" });
});
