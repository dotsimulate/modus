/**
 * Which backend targets the OS file dialog is correct for.
 *
 * The failure this pins is silent and confusing: a native pick under a remote
 * backend returns a path from the user's own machine, which the agent then
 * cannot open. Getting the mode list wrong is the only way that happens.
 */

import { describe, expect, test } from "bun:test";
import { browsedHostLabel, nativePickerApplies } from "../../ui/src/native-picker";

describe("nativePickerApplies", () => {
  test("both local desktop modes share a filesystem with the backend", () => {
    expect(nativePickerApplies(true, "managed-local")).toBe(true);
    expect(nativePickerApplies(true, "external-local")).toBe(true);
  });

  test("a remote backend browses someone else's filesystem", () => {
    expect(nativePickerApplies(true, "remote")).toBe(false);
  });

  test("a plain browser has no native dialog to reach", () => {
    expect(nativePickerApplies(false, "browser")).toBe(false);
    expect(nativePickerApplies(false, "managed-local")).toBe(false);
    expect(nativePickerApplies(false, "external-local")).toBe(false);
    expect(nativePickerApplies(false, "remote")).toBe(false);
  });
});

describe("browsedHostLabel", () => {
  test("stays silent when the native dialog handled the pick", () => {
    expect(browsedHostLabel(true, "http://127.0.0.1:4200", "local")).toBeNull();
  });

  test("stays silent same-origin, where the address bar already names the host", () => {
    expect(browsedHostLabel(false, "", "This browser")).toBeNull();
  });

  test("names the host of a non-local backend", () => {
    expect(browsedHostLabel(false, "http://box.tail1234.ts.net:4200", "box")).toBe("box.tail1234.ts.net:4200");
  });

  test("falls back to the target label when apiBase is not a URL", () => {
    expect(browsedHostLabel(false, "not a url", "box")).toBe("box");
    expect(browsedHostLabel(false, "not a url", "")).toBeNull();
  });
});
