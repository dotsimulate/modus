import { describe, expect, test } from "bun:test";
import { ModusError } from "../../sdk/client";
import { describeSendFailure } from "../../ui/src/send-failure";

describe("send failure description", () => {
  test("names the server's reason from a JSON error body", () => {
    const reason = "[memory-guard] system memory pressure too high: 172.4/189.6 GB";
    const err = new ModusError(503, JSON.stringify({ error: reason }), "/api/sessions");
    expect(describeSendFailure(err)).toBe(reason);
  });

  test("keeps a plain-text detail as is", () => {
    expect(describeSendFailure(new ModusError(500, "Internal Server Error", "/api/sessions")))
      .toBe("Internal Server Error");
  });

  test("falls back to the message of an error without detail", () => {
    expect(describeSendFailure(new Error("network down"))).toBe("network down");
    expect(describeSendFailure("offline")).toBe("offline");
  });
});
