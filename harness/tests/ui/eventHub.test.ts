import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

type Call = { url: string; init: RequestInit; push(frame: string): void };

let hub: typeof import("../../ui/src/eventHub");
let controlIntents: typeof import("../../ui/src/control-intents");
let fsEvents: typeof import("../../ui/src/fsEvents");
const calls: Call[] = [];
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

/** A fetch whose hub responses stay open until aborted, like the real stream. */
function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const url = String(input);
  calls.push({ url, init, push: (frame) => controller.enqueue(encoder.encode(frame)) });
  init.signal?.addEventListener("abort", () => {
    try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ }
  });
  if (!url.includes("/api/events/hub")) return Promise.resolve(Response.json({ ok: true }));
  return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
}

const hubCalls = () => calls.filter((call) => call.url.includes("/api/events/hub"));
const channelsOf = (call: Call) => new URL(call.url, "http://x").searchParams.get("channels");
const settle = () => Bun.sleep(80); // past the connect debounce

beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  globalThis.fetch = fakeFetch as typeof fetch;
  hub = await import("../../ui/src/eventHub");
  controlIntents = await import("../../ui/src/control-intents");
  fsEvents = await import("../../ui/src/fsEvents");
});

afterEach(() => {
  controlIntents.resetControlIntents();
  hub.resetEventHub();
  calls.length = 0;
});

afterAll(() => { globalThis.fetch = originalFetch; });

describe("browser event hub", () => {
  test("every channel shares one connection and events reach only their channel", async () => {
    const sessions: unknown[] = [];
    const fsChanges: unknown[] = [];
    const states: boolean[] = [];
    hub.onHubConnection((connected) => states.push(connected));
    hub.onHubEvent("session", (event) => sessions.push(event));
    hub.onHubEvent("fs", (event) => fsChanges.push(event));
    await settle();

    expect(hubCalls()).toHaveLength(1);
    expect(channelsOf(hubCalls()[0]!)).toBe("session,fs");

    const stream = hubCalls()[0]!;
    stream.push('event: ready\ndata: {"channels":["session","fs"]}\n\n');
    stream.push('event: session\ndata: {"type":"session:title","sessionId":"a"}\n\n');
    stream.push('event: fs\ndata: {"dir":"/p","kind":"add","entry":"x"}\n\n');
    await Bun.sleep(10);

    expect(states).toEqual([true]);
    expect(sessions).toEqual([{ type: "session:title", sessionId: "a" }]);
    expect(fsChanges).toEqual([{ dir: "/p", kind: "add", entry: "x" }]);
  });

  test("a channel change releases the old socket before opening the new one", async () => {
    hub.onHubEvent("session", () => {});
    await settle();
    const first = hubCalls()[0]!;
    let abortedBeforeReopen = false;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      abortedBeforeReopen = first.init.signal!.aborted;
      return fakeFetch(input, init);
    }) as typeof fetch;
    try {
      hub.onHubEvent("control", () => {});
      await settle();
    } finally {
      globalThis.fetch = fetchBefore;
    }
    expect(hubCalls()).toHaveLength(2);
    expect(channelsOf(hubCalls()[1]!)).toBe("session,control");
    expect(abortedBeforeReopen).toBe(true);
  });

  test("the last listener closes the connection and nothing reconnects", async () => {
    const stop = hub.onHubEvent("session", () => {});
    await settle();
    stop();
    await settle();
    expect(hubCalls()).toHaveLength(1);
    expect(hubCalls()[0]!.init.signal!.aborted).toBe(true);
  });

  test("control intents subscribe only while a handler is registered", async () => {
    const seen: string[] = [];
    const stop = controlIntents.onControlIntent("transcript.follow", (intent) => { seen.push(intent.intent); });
    await settle();
    expect(channelsOf(hubCalls()[0]!)).toBe("control");
    hubCalls()[0]!.push('event: control\ndata: {"intent":"transcript.follow"}\n\n');
    hubCalls()[0]!.push('event: control\ndata: {"intent":"not-a-real-intent"}\n\n');
    await Bun.sleep(10);
    expect(seen).toEqual(["transcript.follow"]);

    stop();
    await settle();
    expect(hubCalls()[0]!.init.signal!.aborted).toBe(true);
  });

  test("the fs watch root is re-sent whenever the hub reconnects", async () => {
    fsEvents.onFsChange(() => {});
    fsEvents.setFsWatchRoot("/project");
    await settle();
    const roots = () => calls.filter((call) => call.url.endsWith("/api/events/fs/root")).map((call) => JSON.parse(String(call.init.body)).root);
    expect(roots()).toEqual(["/project"]);

    hubCalls()[0]!.push('event: ready\ndata: {}\n\n');
    await Bun.sleep(10);
    expect(roots()).toEqual(["/project", "/project"]);
  });
});
