import type { Hono } from "hono";
import { markSessionReplyRead } from "./db";

export function registerSessionReadRoute(
  app: Hono,
  onRead: (sessionId: string, lastReplySeq: number, readReplySeq: number) => void,
  resolveId: (sessionId: string) => string = (id) => id,
): void {
  app.post("/api/sessions/:id/read", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!Number.isSafeInteger(body?.seq) || body.seq < 0) {
      return c.json({ error: "seq must be a nonnegative integer" }, 400);
    }
    const id = resolveId(c.req.param("id"));
    const row = markSessionReplyRead(id, body.seq);
    if (!row) return c.json({ error: "session not found" }, 404);
    onRead(id, row.last_reply_seq, row.read_reply_seq);
    return c.json({ last_reply_seq: row.last_reply_seq, read_reply_seq: row.read_reply_seq });
  });
}
