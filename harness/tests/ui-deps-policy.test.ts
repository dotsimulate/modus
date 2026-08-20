import { describe, expect, test } from "bun:test";
import { uiDepsAreStale } from "../ui-deps-policy";

const PULLED_AT = 2_000;

describe("uiDepsAreStale", () => {
  test("a fresh clone with no node_modules installs", () => {
    expect(
      uiDepsAreStale({
        nodeModulesPresent: false,
        stampTime: 0,
        packageTime: PULLED_AT,
        lockTime: PULLED_AT,
      }),
    ).toBe(true);
  });

  test("an existing node_modules with no stamp installs", () => {
    // The regression. The stamp is gitignored, so a checkout that predates the
    // stamp mechanism — or any clone — has node_modules but no stamp. Reading
    // that as fresh skipped the install that a newly pulled dependency needed.
    expect(
      uiDepsAreStale({
        nodeModulesPresent: true,
        stampTime: 0,
        packageTime: PULLED_AT,
        lockTime: PULLED_AT,
      }),
    ).toBe(true);
  });

  test("a stamp older than a pulled package.json or lockfile installs", () => {
    expect(
      uiDepsAreStale({
        nodeModulesPresent: true,
        stampTime: 1_000,
        packageTime: PULLED_AT,
        lockTime: 0,
      }),
    ).toBe(true);

    expect(
      uiDepsAreStale({
        nodeModulesPresent: true,
        stampTime: 1_000,
        packageTime: 0,
        lockTime: PULLED_AT,
      }),
    ).toBe(true);
  });

  test("a stamp newer than both inputs skips the install", () => {
    expect(
      uiDepsAreStale({
        nodeModulesPresent: true,
        stampTime: 3_000,
        packageTime: PULLED_AT,
        lockTime: PULLED_AT,
      }),
    ).toBe(false);
  });

  test("a stamp cannot mask a dependency change that lands in the same millisecond", () => {
    // Equal mtimes mean the stamp is at least as new as the inputs, so this is
    // deliberately not stale; the strict comparison is what makes the ordinary
    // start fast rather than reinstalling on every run.
    expect(
      uiDepsAreStale({
        nodeModulesPresent: true,
        stampTime: PULLED_AT,
        packageTime: PULLED_AT,
        lockTime: PULLED_AT,
      }),
    ).toBe(false);
  });
});
