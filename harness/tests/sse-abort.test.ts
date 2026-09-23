import { describe, expect, test } from "bun:test";
import { onClientAbort } from "../sse-abort";

/**
 * Serve one direct SSE stream that writes catch-up frames before registering
 * its disconnect cleanup — the shape of `/api/events/multi` — and report
 * whether the cleanup ran after the client went away mid catch-up.
 */
async function cleanupRanAfterEarlyDisconnect(register: (signal: AbortSignal, onAbort: () => void) => void) {
  const encoder = new TextEncoder();
  let cleanedUp = false;
  let handlerSettled!: () => void;
  const settled = new Promise<void>((resolve) => { handlerSettled = resolve; });
  let clientGone!: () => void;
  const disconnected = new Promise<void>((resolve) => { clientGone = resolve; });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const stream = new ReadableStream({
        type: "direct" as any,
        async pull(controller: any) {
          controller.write(encoder.encode("event: catchup-start\ndata: {}\n\n"));
          await controller.flush();
          await disconnected;
          // Let the server observe the closed socket before registering.
          while (!req.signal.aborted) await Bun.sleep(10);
          let resolve!: () => void;
          const done = new Promise<void>((r) => { resolve = r; });
          register(req.signal, () => { cleanedUp = true; resolve(); });
          await Promise.race([done, Bun.sleep(500)]);
          handlerSettled();
          try { controller.close(); } catch { /* already closed */ }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  try {
    const client = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/`, { signal: client.signal });
    await response.body!.getReader().read();
    client.abort();
    clientGone();
    await settled;
    return cleanedUp;
  } finally {
    server.stop(true);
  }
}

describe("SSE client disconnect", () => {
  test("a listener registered after the disconnect never fires on its own", async () => {
    // Locks the runtime behavior the helper exists for; if Bun ever changes
    // this, the helper is still correct but the reason for it is gone.
    const ran = await cleanupRanAfterEarlyDisconnect((signal, onAbort) => {
      signal.addEventListener("abort", onAbort);
    });
    expect(ran).toBe(false);
  });

  test("onClientAbort cleans up a handler whose client left during catch-up", async () => {
    const ran = await cleanupRanAfterEarlyDisconnect(onClientAbort);
    expect(ran).toBe(true);
  });
});
