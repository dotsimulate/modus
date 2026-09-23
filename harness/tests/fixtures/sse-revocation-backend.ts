// Exercise the real backend with a delayed SSE flush, as a slow network can do.
// The parent test releases the flush only after the lock response has arrived.
if (process.env.NODE_ENV !== "test" || !process.env.MODUS_SSE_PAUSE_MARKER || !process.env.MODUS_SSE_RELEASE_MARKER) {
  throw new Error("SSE revocation fixture requires isolated test markers");
}

const { existsSync, writeFileSync } = await import("node:fs");
const pauseMarker = process.env.MODUS_SSE_PAUSE_MARKER;
const releaseMarker = process.env.MODUS_SSE_RELEASE_MARKER;
const NativeReadableStream = globalThis.ReadableStream;

globalThis.ReadableStream = class extends NativeReadableStream {
  constructor(source: any, strategy?: any) {
    if (source?.type === "direct" && typeof source.pull === "function") {
      const pull = source.pull;
      source = {
        ...source,
        async pull(controller: any) {
          let pauseNextDirectFlush = true;
          const flush = controller.flush.bind(controller);
          const delayedFlush = async (...args: unknown[]) => {
            const result = await flush(...args);
            if (pauseNextDirectFlush) {
              pauseNextDirectFlush = false;
              writeFileSync(pauseMarker, "paused");
              while (!existsSync(releaseMarker)) await Bun.sleep(10);
            }
            return result;
          };
          const wrapped = new Proxy(controller, {
            get(target, property) {
              if (property === "flush") return delayedFlush;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return pull(wrapped);
        },
      };
    }
    super(source, strategy);
  }
} as typeof ReadableStream;

await import("../../index.ts");
