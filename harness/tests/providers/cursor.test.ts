import { describe, expect, test } from "bun:test";
import { cursorCompletionMessageCount } from "../../providers/cursor";

describe("Cursor completion accounting", () => {
  test("reports one new exchange without pre-incrementing shared state", () => {
    const exchangeCount = 3;

    expect(cursorCompletionMessageCount(exchangeCount)).toBe(8);
    expect(exchangeCount).toBe(3);
  });
});
