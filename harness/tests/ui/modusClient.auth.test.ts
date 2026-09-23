import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearAuthToken, getAuthToken, modus, setAuthToken, tokenParam } from "../../ui/src/modusClient";

const originalStorage = globalThis.localStorage;
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;
});

afterEach(() => { globalThis.localStorage = originalStorage; });

describe("UI browser-session URL tokens", () => {
  test("does not copy a legacy supervisor bearer into URLs", () => {
    values.set("harness_token", "supervisor-secret");
    expect(getAuthToken()).toBe("supervisor-secret");
    expect(tokenParam()).toBe("");
    expect(modus.previewUrl("/api/artifacts/raw")).not.toContain("supervisor-secret");
  });

  test("tracks the browser session and clears its URL designation", () => {
    setAuthToken("browser+session");
    expect(tokenParam()).toBe("token=browser%2Bsession");
    expect(modus.previewUrl("/api/artifacts/raw")).toContain("token=browser%2Bsession");
    clearAuthToken();
    expect(values.size).toBe(0);
    expect(tokenParam()).toBe("");
  });
});
