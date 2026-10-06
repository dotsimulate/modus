import { afterEach, expect, test } from "bun:test";
import { ModusClient, ModusError } from "../../sdk/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("model discovery preserves the SDK's default empty-array behavior on HTTP failure", async () => {
  globalThis.fetch = (async () => Response.json({ error: "Cursor sign-in required" }, { status: 502 })) as typeof fetch;
  const client = new ModusClient({ url: "http://models.invalid" });
  expect(await client.getProviderModels("cursor")).toEqual([]);
});

test("strict model discovery exposes the server's error to model pickers", async () => {
  globalThis.fetch = (async () => Response.json({ error: "Cursor sign-in required" }, { status: 502 })) as typeof fetch;
  const client = new ModusClient({ url: "http://models.invalid" });
  try {
    await client.getProviderModels("cursor", { throwOnError: true });
    throw new Error("Expected discovery to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ModusError);
    expect((error as ModusError).status).toBe(502);
    expect(JSON.parse((error as ModusError).detail)).toEqual({ error: "Cursor sign-in required" });
  }
});

test("strict model discovery returns every suggestion from the provider endpoint", async () => {
  const models = [{ id: "account-model", owned_by: "cursor" }, { id: "auto", owned_by: "cursor" }];
  globalThis.fetch = (async (input) => {
    expect(String(input)).toBe("http://models.invalid/api/providers/cursor/models");
    return Response.json(models);
  }) as typeof fetch;
  const client = new ModusClient({ url: "http://models.invalid" });
  expect(await client.getProviderModels("cursor", { throwOnError: true })).toEqual(models);
});
