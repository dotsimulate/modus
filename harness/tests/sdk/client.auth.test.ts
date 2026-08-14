import { afterEach, describe, expect, test } from "bun:test";
import { ModusClient, ModusError } from "../../sdk/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ModusClient browser authentication bootstrap", () => {
  test("discovers token requirements and creates a no-PIN browser session without a URL token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/auth/status")) {
        return Response.json({ required: false, setup: false, tokenRequired: true, name: "tester" });
      }
      if (url.endsWith("/api/auth/session")) {
        return Response.json({ ok: true, token: "browser-session-token" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new ModusClient({ url: "http://127.0.0.1:49152/" });
    const status = await client.authStatus();
    const token = status.tokenRequired ? await client.createBrowserSession() : null;

    expect(token).toBe("browser-session-token");
    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:49152/api/auth/status",
      "http://127.0.0.1:49152/api/auth/session",
    ]);
    expect(requests.every(({ url }) => !url.includes("token="))).toBe(true);
    expect(requests[0]?.init).toBeUndefined();
  });

  test("reports a failed auth-status response as a typed error instead of parsing it as state", async () => {
    globalThis.fetch = (async () => Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch;
    const client = new ModusClient({ url: "https://modus.example" });

    try {
      await client.authStatus();
      throw new Error("expected authStatus to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModusError);
      expect((error as ModusError).status).toBe(401);
      expect((error as ModusError).path).toBe("/api/auth/status");
    }
  });

  test("reports no-PIN browser-session rejection as a typed error", async () => {
    globalThis.fetch = (async () => new Response("PIN verification required", { status: 403 })) as typeof fetch;
    const client = new ModusClient({ url: "https://modus.example" });

    await expect(client.createBrowserSession()).rejects.toMatchObject({
      name: "ModusError",
      status: 403,
      path: "/api/auth/session",
    });
  });
});
