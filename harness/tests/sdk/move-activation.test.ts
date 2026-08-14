import { afterEach, describe, expect, test } from "bun:test";
import { ModusClient } from "../../sdk/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("ModusClient move activation", () => {
  test("launchMove preserves the inline prompt and dispatch signal", async () => {
    const response = {
      token: "move-token",
      mode: "inline" as const,
      prompt: "gathered prompt",
      requiresDispatch: true,
      moveRunId: 17,
      apiToken: "mapi-test-instance1",
      instanceId: "instance1",
    };
    globalThis.fetch = (async () => Response.json(response)) as typeof fetch;

    const client = new ModusClient({ url: "https://modus.example", token: "test" });
    const result = await client.launchMove("fixture", "C:/project", { sessionId: "session-1" });
    expect(result).toEqual(response);
  });
});
