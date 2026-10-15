import { afterEach, expect, test } from "bun:test";
import { ModusClient, ModusError } from "../../sdk/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// An unauthorized response must not be handed to widgets as if it were stats:
// the pricing widget destructured `stats.totals` from the 401 body and crashed.
for (const [name, call] of [
  ["getSessionStats", (client: ModusClient) => client.getSessionStats()],
  ["getAccountInfo", (client: ModusClient) => client.getAccountInfo()],
] as const) {
  test(`${name} throws ModusError instead of returning an error body`, async () => {
    globalThis.fetch = (async () => Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch;
    const client = new ModusClient({ url: "http://stats.invalid" });
    try {
      await call(client);
      throw new Error("Expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModusError);
      expect((error as ModusError).status).toBe(401);
    }
  });
}

test("getSessionStats returns the stats body on success", async () => {
  const stats = { totals: { cost: 1.5, sessions: 2 } };
  globalThis.fetch = (async (input) => {
    expect(String(input)).toBe("http://stats.invalid/api/stats/sessions?userProfile=dot");
    return Response.json(stats);
  }) as typeof fetch;
  const client = new ModusClient({ url: "http://stats.invalid" });
  expect(await client.getSessionStats("dot")).toEqual(stats);
});
