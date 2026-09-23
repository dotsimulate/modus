import { expect, test } from "bun:test";
import { configureBackendTarget } from "../../ui/src/backendTarget";
import { getState, play, resolveUrl, stop } from "../../ui/src/audio-player";

test("audio fetch keeps the browser token out of URLs and media errors", async () => {
  const token = "browser-session-secret";
  const artifact = "/api/sessions/ses-1/artifacts/3?download=1";
  const origin = "http://127.0.0.1:51393";
  const events = new Map<string, () => void>();
  const audio = {
    style: {},
    dataset: {},
    src: "",
    error: { code: 3, message: "decode failed" },
    preload: "",
    paused: false,
    addEventListener(name: string, listener: () => void) { events.set(name, listener); },
    play: () => Promise.resolve(),
    pause: () => {},
    removeAttribute: () => {},
    load: () => {},
  };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldFetch = globalThis.fetch;
  const oldCreateObjectURL = URL.createObjectURL;
  const oldRevokeObjectURL = URL.revokeObjectURL;
  const oldConsoleError = console.error;
  const calls: { url: string; authorization: string | null }[] = [];
  const errors: unknown[][] = [];

  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => audio, body: { appendChild: () => {} } },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => token },
    });
    URL.createObjectURL = () => "blob:audio-test";
    URL.revokeObjectURL = () => {};
    console.error = (...args: unknown[]) => { errors.push(args); };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return new Response(new Blob(["audio"], { type: "audio/wav" }), {
        headers: { "Content-Type": "audio/wav" },
      });
    }) as typeof fetch;

    configureBackendTarget({ search: `?modusTarget=${encodeURIComponent(origin)}&modusTargetMode=managed-local` });
    expect(resolveUrl(artifact)).toBe(`${origin}${artifact}`);
    play(3, artifact);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([{ url: `${origin}${artifact}`, authorization: `Bearer ${token}` }]);
    expect(audio.src).toBe("blob:audio-test");
    expect(getState().src).toBe(artifact);

    events.get("error")?.();
    expect(JSON.stringify(errors)).not.toContain(token);
    expect(getState().error).toContain("MEDIA_ERR_DECODE");
  } finally {
    stop();
    configureBackendTarget({ search: "" });
    globalThis.fetch = oldFetch;
    URL.createObjectURL = oldCreateObjectURL;
    URL.revokeObjectURL = oldRevokeObjectURL;
    console.error = oldConsoleError;
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
