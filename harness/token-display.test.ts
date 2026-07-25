import { describe, expect, test } from "bun:test";
import { formatTokenForBanner } from "./token-display";

const CANARY = "canary0123456789abcdef0123456789";

describe("supervisor token banner display", () => {
  test("never emits the token value by default", () => {
    const line = formatTokenForBanner(CANARY, "generated", false);
    expect(line).not.toContain(CANARY);
    expect(line).toContain("set (generated)");
    expect(line).toContain("--show-token");
  });

  test("does not leak a partial prefix of the token", () => {
    const line = formatTokenForBanner(CANARY, "generated", false);
    for (let length = 4; length <= CANARY.length; length += 1) {
      expect(line).not.toContain(CANARY.slice(0, length));
    }
  });

  test("emits the token only on explicit reveal", () => {
    expect(formatTokenForBanner(CANARY, "env", true)).toBe(`${CANARY} (env)`);
  });

  test("reports an absent token without implying one is set", () => {
    const line = formatTokenForBanner("", "generated", false);
    expect(line).toBe("none (generated)");
    expect(line).not.toContain("set (");
  });
});
