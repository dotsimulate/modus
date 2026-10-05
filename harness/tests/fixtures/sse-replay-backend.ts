import { mock } from "bun:test";
import type { TurnContext } from "../../providers/types";

if (process.env.NODE_ENV !== "test" || !process.env.MODUS_HOME) {
  throw new Error("SSE replay fixture requires an isolated test home");
}

let context!: TurnContext;
const provider = {
  capabilities: { name: "codex", supportsImages: false },
  startTurn(ctx: TurnContext) {
    context = ctx;
    ctx.session.status = "running";
    ctx.emitEvent({ type: "user", subtype: "prompt", message: { content: "opening" } });
    ctx.emitEvent({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  },
  steerMessage() { return true; },
  abort() {},
};
mock.module("../../providers/registry", () => ({
  getProvider: () => provider,
  getProviderCapabilities: () => provider.capabilities,
  listProviderCapabilities: () => [],
  listProviders: () => ["codex"],
  isKnownProvider: () => true,
  checkProviderHealth: async () => ({ status: "ready", checks: [] }),
}));

const { startSession, steerMessage } = await import("../../session-manager");
startSession({ sessionId: "sse-replay-fixture", provider: "codex", prompt: "opening", cwd: process.env.MODUS_HOME });

// Inject while the first catch-up frame is being flushed, then advance the
// live cursor. Without an early subscription this prompt falls through the gap.
let interjections = 0;
const NativeReadableStream = globalThis.ReadableStream;
globalThis.ReadableStream = class extends NativeReadableStream {
  constructor(source: any, strategy?: any) {
    if (source?.type === "direct" && typeof source.pull === "function") {
      const pull = source.pull;
      source = {
        ...source,
        async pull(controller: any) {
          let inject = false;
          const wrapped = new Proxy(controller, {
            get(target, property) {
              if (property === "write") return (chunk: Uint8Array) => {
                if (new TextDecoder().decode(chunk).includes("event: catchup-start") && interjections < 3) {
                  inject = true;
                }
                return target.write(chunk);
              };
              if (property === "flush") return async () => {
                const result = await target.flush();
                if (inject) {
                  inject = false;
                  interjections++;
                  await steerMessage(context.session.sessionId, "continue");
                  context.emitEvent({ type: "stream_event", event: {
                    type: "content_block_delta", delta: { type: "text_delta", text: " still working".repeat(30) },
                  } });
                  const marker = ` stream-marker-${interjections}`;
                  setTimeout(() => context.emitEvent({ type: "stream_event", event: {
                    type: "content_block_delta", delta: { type: "text_delta", text: marker },
                  } }), 100);
                }
                return result;
              };
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

await import("../../index");
