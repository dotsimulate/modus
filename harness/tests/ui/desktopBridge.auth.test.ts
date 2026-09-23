import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindManagedDesktopTarget, type DesktopBootstrapResponse } from "../../ui/src/desktopBridge";

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
const target: DesktopBootstrapResponse = {
  mode: "managed-local",
  apiBase: "http://127.0.0.1:49152",
  targetId: "managed-local:test",
  label: "Modus",
  token: "supervisor-secret",
  instanceId: "instance-1",
  version: "0.1.0",
  port: 49152,
};

let values: Map<string, string>;

beforeEach(() => {
  values = new Map([
    ["harness_token:managed-local%3Atest", "old-supervisor"],
    ["harness_browser_session:managed-local%3Atest", "old-supervisor"],
  ]);
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalStorage;
});

describe("managed desktop browser-session exchange", () => {
  test("stores only the minted browser session", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input, init) => {
      paths.push(String(input));
      expect(init?.headers).toEqual({ Authorization: "Bearer supervisor-secret" });
      return paths.length === 1
        ? Response.json({ ok: true, kind: "agent" })
        : Response.json({ ok: true, token: "browser-session" });
    }) as typeof fetch;

    await bindManagedDesktopTarget(target);
    expect(paths).toEqual([
      "http://127.0.0.1:49152/api/auth/check",
      "http://127.0.0.1:49152/api/auth/exchange",
    ]);
    expect([...values.values()]).toEqual(["browser-session", "browser-session"]);
  });

  test("fails closed when exchange fails and clears a prior supervisor bearer", async () => {
    globalThis.fetch = (async (input) => String(input).endsWith("/check")
      ? Response.json({ ok: true, kind: "agent" })
      : Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch;

    await expect(bindManagedDesktopTarget(target)).rejects.toThrow("session-token exchange failed");
    expect(values.size).toBe(0);
  });

  test("rejects a token that is not distinct from the supervisor bearer", async () => {
    globalThis.fetch = (async (input) => String(input).endsWith("/check")
      ? Response.json({ ok: true, kind: "agent" })
      : Response.json({ ok: true, token: "supervisor-secret" })) as typeof fetch;

    await expect(bindManagedDesktopTarget(target)).rejects.toThrow("distinct browser-session token");
    expect(values.size).toBe(0);
  });
});
