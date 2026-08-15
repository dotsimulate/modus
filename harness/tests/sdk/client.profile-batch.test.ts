import { afterEach, describe, expect, test } from "bun:test";
import { ModusClient } from "../../sdk/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function recordingClient(): { client: ModusClient; urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json([]);
  }) as typeof fetch;
  return { client: new ModusClient({ url: "http://127.0.0.1:49152/" }), urls };
}

/**
 * Listing profiles and then requesting each profile's UI config separately was a
 * 1+N round trip re-run on every project change, and client extensions could not
 * resolve until all of it finished. These pin the batched request shape.
 */
describe("profile listing batches UI config", () => {
  test("asks for inline UI config for agent profiles, alongside cwd", async () => {
    const { client, urls } = recordingClient();
    await client.listProfiles("D:/work/thing", { includeUi: true });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("ui=1");
    expect(urls[0]).toContain("cwd=D%3A%2Fwork%2Fthing");
  });

  test("asks for inline UI config for user profiles", async () => {
    const { client, urls } = recordingClient();
    await client.listUserProfiles({ includeUi: true });
    expect(urls).toEqual(["http://127.0.0.1:49152/api/user-profiles?ui=1"]);
  });

  test("omits the flag entirely when it was not requested", async () => {
    const { client, urls } = recordingClient();
    await client.listProfiles();
    await client.listUserProfiles();
    expect(urls).toEqual([
      "http://127.0.0.1:49152/api/profiles",
      "http://127.0.0.1:49152/api/user-profiles",
    ]);
  });

  test("still sends cwd without the flag", async () => {
    const { client, urls } = recordingClient();
    await client.listProfiles("/tmp/p");
    expect(urls[0]).toBe("http://127.0.0.1:49152/api/profiles?cwd=%2Ftmp%2Fp");
  });
});
