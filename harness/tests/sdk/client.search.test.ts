import { afterEach, expect, test } from "bun:test";
import { ModusClient } from "../../sdk/client";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("search sends words, phrases, sort, scope and pagination without losing quotes", async () => {
  let url: URL | undefined;
  const hits = [{ session_id: "example", preview: "Example", snippet: "access token" }];
  globalThis.fetch = (async (input: string | URL | Request) => {
    url = new URL(String(input));
    return Response.json(hits);
  }) as typeof fetch;
  const client = new ModusClient({ url: "http://search.invalid" });
  expect(await client.searchSessions('auth "access token"', { sort: "latest", limit: 21, offset: 20, userProfile: "example" })).toEqual(hits);
  expect(url?.pathname).toBe("/api/sessions/search");
  expect(Object.fromEntries(url!.searchParams)).toEqual({ q: 'auth "access token"', sort: "latest", limit: "21", offset: "20", userProfile: "example" });
});

test("blank search avoids a request and old callers keep the default contract", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json([]);
  }) as typeof fetch;
  const client = new ModusClient({ url: "http://search.invalid" });
  expect(await client.searchSessions(" \t ")).toEqual([]);
  expect(urls).toEqual([]);
  await client.searchSessions("auth refactor");
  expect(urls).toEqual(["http://search.invalid/api/sessions/search?q=auth+refactor"]);
});

test("CLI prints actual search result fields without accessing a live backend", async () => {
  const proc = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "../fixtures/search-cli-preload.ts"),
    join(import.meta.dir, "../../sdk/cli.ts"), "search", "auth", "refactor", "--sort", "latest", "--offset", "20",
  ], {
    env: { ...process.env, MODUS_URL: "http://search.invalid", MODUS_PIN: "", MODUS_TOKEN: "test-only" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("example-session  1970-01-01T00:00:01.000Z  Example conversation");
  expect(stdout).toContain("auth and refactor");
});
