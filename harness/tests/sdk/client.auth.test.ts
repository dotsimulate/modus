import { afterEach, describe, expect, test } from "bun:test";
import { ModusClient, ModusError } from "../../sdk/client";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

describe("ModusClient browser authentication bootstrap", () => {
  test("keeps an arbitrary API bearer out of browser resource URLs", () => {
    const eventUrls: string[] = [];
    globalThis.EventSource = class {
      constructor(url: string) { eventUrls.push(url); }
    } as typeof EventSource;
    const client = new ModusClient({ url: "https://modus.example", token: "supervisor-secret" });
    expect(client.tokenParam()).toBe("");
    expect(client.getWidgetUrl("clock", "/project")).not.toContain("supervisor-secret");
    expect(client.getWidgetCssUrl("clock", "/project")).not.toContain("supervisor-secret");
    expect(client.previewUrl("/api/artifacts/raw?id=1")).not.toContain("supervisor-secret");
    client.connectFsEvents("/project");
    expect(eventUrls[0]).not.toContain("supervisor-secret");
    expect(client.authHeaders().Authorization).toBe("Bearer supervisor-secret");
  });

  test("uses a designated browser session only on local resource URLs", () => {
    const eventUrls: string[] = [];
    globalThis.EventSource = class {
      constructor(url: string) { eventUrls.push(url); }
    } as typeof EventSource;
    const browserToken = "session+secret/1";
    const client = new ModusClient({
      url: "https://modus.example",
      token: browserToken,
      browserSessionToken: browserToken,
    });
    expect(client.tokenParam()).toBe("token=session%2Bsecret%2F1");
    expect(new URL(client.getWidgetUrl("clock", "/project")).searchParams.get("token")).toBe(browserToken);
    expect(new URL(client.getWidgetCssUrl("clock", "/project")).searchParams.get("token")).toBe(browserToken);
    expect(new URL(client.previewUrl("/api/artifacts/raw?id=1")).searchParams.get("token")).toBe(browserToken);
    client.connectFsEvents("/project");
    expect(new URL(eventUrls[0]!).searchParams.get("token")).toBe(browserToken);
    expect(client.previewUrl("https://external.example/file")).toBe("https://external.example/file");
    client.setToken("new-supervisor");
    expect(client.tokenParam()).toBe("");
  });

  test("reports the backend token kind", async () => {
    globalThis.fetch = (async () => Response.json({ ok: true, kind: "browser" })) as typeof fetch;
    const client = new ModusClient({ url: "https://modus.example", token: "browser-session" });
    expect(await client.checkToken()).toBe("browser");
  });

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
