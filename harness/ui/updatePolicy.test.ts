import { describe, expect, test } from "bun:test";
import {
  LAST_UPDATE_CHECK_KEY,
  UPDATE_CHECK_INTERVAL_MS,
  automaticUpdateChecksEnabled,
  parseUpdateUrgency,
  recordUpdateCheck,
  setAutomaticUpdateChecksEnabled,
  shouldCheckForUpdates,
} from "./src/update-policy";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("desktop update policy", () => {
  test("recognizes explicit release urgency while defaulting safely", () => {
    expect(parseUpdateUrgency()).toBe("normal");
    expect(parseUpdateUrgency("[modus-update:recommended]\nBug fixes")).toBe("recommended");
    expect(parseUpdateUrgency("<!-- modus-update:critical -->\nSecurity update")).toBe("critical");
  });

  test("keeps automatic checks opt-in and native-only", () => {
    const storage = memoryStorage();
    expect(automaticUpdateChecksEnabled(storage)).toBe(false);
    setAutomaticUpdateChecksEnabled(true, storage);
    expect(automaticUpdateChecksEnabled(storage)).toBe(true);
    expect(shouldCheckForUpdates({ nativeDesktop: false, enabled: true, now: 100, storage })).toBe(false);
    expect(shouldCheckForUpdates({ nativeDesktop: true, enabled: false, now: 100, storage })).toBe(false);
    expect(shouldCheckForUpdates({ nativeDesktop: true, enabled: true, now: 100, storage })).toBe(true);
  });

  test("checks at most once per day unless the user checks manually", () => {
    const storage = memoryStorage();
    recordUpdateCheck(1_000, storage);
    expect(storage.getItem(LAST_UPDATE_CHECK_KEY)).toBe("1000");
    expect(shouldCheckForUpdates({ nativeDesktop: true, enabled: true, now: 1_000 + UPDATE_CHECK_INTERVAL_MS - 1, storage })).toBe(false);
    expect(shouldCheckForUpdates({ nativeDesktop: true, enabled: true, now: 1_000 + UPDATE_CHECK_INTERVAL_MS, storage })).toBe(true);
  });
});

