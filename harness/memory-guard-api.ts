import { Hono } from "hono";
import { getMemoryStatus, setMaxConcurrentSessions } from "./memory-guard";

// Mounted behind the harness's operator authentication middleware.
export const memoryGuardApi = new Hono();

memoryGuardApi.get("/", (c) => c.json(getMemoryStatus()));

memoryGuardApi.put("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || !("maxConcurrentSessions" in body)) {
    return c.json({ error: "Expected { maxConcurrentSessions: positive integer }" }, 400);
  }
  try {
    setMaxConcurrentSessions(body.maxConcurrentSessions);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  return c.json(getMemoryStatus());
});
