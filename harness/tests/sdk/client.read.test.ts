import { afterEach, expect, test } from "bun:test";
import { ModusClient } from "../../sdk/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("read receipt carries the observed sequence and returns server watermarks", async () => {
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("http://read.invalid/api/sessions/example/read");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ seq: 10 });
    return Response.json({ last_reply_seq: 20, read_reply_seq: 10 });
  }) as typeof fetch;
  const client = new ModusClient({ url: "http://read.invalid" });
  expect(await client.markSessionReplyRead("example", 10)).toEqual({ last_reply_seq: 20, read_reply_seq: 10 });
});

test("a failed receipt remains a failure so the client can retry", async () => {
  globalThis.fetch = (async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch;
  const client = new ModusClient({ url: "http://read.invalid" });
  await expect(client.markSessionReplyRead("example", 10)).rejects.toThrow();
});
