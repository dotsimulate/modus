import { strict as assert } from "node:assert";

// No network request is sent by the CLI regression driver.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  assert.equal(url.pathname, "/api/sessions/search");
  assert.equal(url.searchParams.get("q"), "auth refactor");
  assert.equal(url.searchParams.get("sort"), "latest");
  assert.equal(url.searchParams.get("offset"), "20");
  return Response.json([{
    session_id: "example-session", preview: "Example conversation", snippet: "auth and refactor",
    profile: null, model: null, cwd: null, last_message_at: 1000, total_cost_usd: 0,
  }]);
}) as typeof fetch;
