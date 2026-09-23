import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

let streams: typeof import("../../ui/src/multiEventStream");
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const timers = new Map<number, { delay: number; run: () => void }>();
const requests: Array<{ signal: AbortSignal; body: ReadableStreamDefaultController<Uint8Array> }> = [];
let nextTimer = 0;

function installStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem() {}, removeItem() {} },
  });
}

beforeAll(async () => {
  installStorage();
  streams = await import("../../ui/src/multiEventStream");
});

beforeEach(() => {
  installStorage();
  streams.multiResume();
  globalThis.setTimeout = ((run: () => void, delay: number) => {
    const id = ++nextTimer;
    timers.set(id, { delay, run });
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
  globalThis.fetch = ((_input: RequestInfo | URL, init: RequestInit) => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    requests.push({ signal: init.signal!, body });
    init.signal!.addEventListener("abort", () => body.error(new DOMException("aborted", "AbortError")));
    return Promise.resolve(new Response(stream));
  }) as typeof fetch;
});

afterEach(() => {
  streams.multiUnsubscribeAll();
  timers.clear();
  requests.length = 0;
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function fire(delay: number) {
  const entry = [...timers].find(([, timer]) => timer.delay === delay);
  expect(entry, `timer for ${delay}ms`).toBeDefined();
  timers.delete(entry![0]);
  entry![1].run();
  await flush();
}

function subscribe(id = "session-a") {
  streams.multiSubscribe(id, 0, { onEvent() {}, onDone() {} });
}

describe("multiplexed stream recovery", () => {
  test("a stale stream reconnects after its watchdog aborts it", async () => {
    subscribe();
    await fire(40);
    await fire(45_000);
    expect(requests[0]!.signal.aborted).toBe(true);
    await fire(40);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.signal.aborted).toBe(false);
  });

  test("a hung handshake is bounded before any response arrives", async () => {
    let signal!: AbortSignal;
    globalThis.fetch = ((_input: RequestInfo | URL, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof fetch;
    subscribe();
    await fire(40);
    await fire(45_000);
    expect(signal.aborted).toBe(true);
    await fire(40);
    expect(signal.aborted).toBe(false);
  });

  test("an old reader's rejection cannot remove its replacement's watchdog", async () => {
    subscribe();
    await fire(40);
    subscribe("session-b");
    await fire(40);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect([...timers.values()].filter((timer) => timer.delay === 45_000)).toHaveLength(1);
    await fire(45_000);
    expect(requests[1]!.signal.aborted).toBe(true);
  });

  test("transient failures keep one multiplexed request instead of opening per-chat streams", async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.reject(new TypeError("network unavailable"));
    }) as typeof fetch;
    subscribe();
    subscribe("session-b");
    await fire(40);
    await fire(500);
    await fire(1000);
    await fire(1500);
    expect(urls).toHaveLength(4);
    expect(urls.every((url) => url.endsWith("/api/events/multi"))).toBe(true);
  });
});
