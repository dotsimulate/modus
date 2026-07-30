import { afterEach, describe, expect, test } from "bun:test";
import whisperTranscribeExtension, {
  describeCaptureError,
  describeCaptureSupport,
  describeMicDevice,
  failure,
  levelToMeter,
  matchAudioInputDevice,
  pickLoudestChannel,
  shouldWarnNoInput,
  shouldWarnTooQuiet,
} from "./extensions/whisper-transcribe.js";

const DEVICES = [
  { kind: "audiooutput", deviceId: "spk-1", label: "Speakers (Realtek)" },
  { kind: "audioinput", deviceId: "default", label: "Default - Microphone Array" },
  { kind: "audioinput", deviceId: "a1b2c3", label: "Shure MV7 (USB Audio)" },
  { kind: "audioinput", deviceId: "d4e5f6", label: "Microphone Array (Intel Smart Sound)" },
];

describe("whisper-transcribe mic selection", () => {
  test("prefers an exact deviceId over any label", () => {
    // "default" is also a substring of another device's label, so an id match
    // must win outright or pasting an id would pick the wrong input.
    expect(matchAudioInputDevice(DEVICES, "d4e5f6")?.label)
      .toBe("Microphone Array (Intel Smart Sound)");
  });

  test("matches a case-insensitive label fragment", () => {
    expect(matchAudioInputDevice(DEVICES, "shure")?.deviceId).toBe("a1b2c3");
    expect(matchAudioInputDevice(DEVICES, "USB Audio")?.deviceId).toBe("a1b2c3");
  });

  test("never selects a non-input device", () => {
    expect(matchAudioInputDevice(DEVICES, "spk-1")).toBeNull();
    expect(matchAudioInputDevice(DEVICES, "Realtek")).toBeNull();
  });

  test("returns null for no preference or no match", () => {
    expect(matchAudioInputDevice(DEVICES, "")).toBeNull();
    expect(matchAudioInputDevice(DEVICES, "   ")).toBeNull();
    expect(matchAudioInputDevice(DEVICES, undefined)).toBeNull();
    expect(matchAudioInputDevice(DEVICES, "blue yeti")).toBeNull();
    expect(matchAudioInputDevice(undefined, "shure")).toBeNull();
  });

  test("describes which input actually ended up live", () => {
    expect(describeMicDevice(DEVICES[2], "shure")).toBe("Shure MV7 (USB Audio)");
    // The unmatched case has to be visible, or a wrong-device recording looks
    // exactly like a working one.
    expect(describeMicDevice(null, "blue yeti")).toBe(`system default (no match for "blue yeti")`);
    expect(describeMicDevice(null, "")).toBe("system default");
    // A device whose label is still locked behind permissions falls back to id.
    expect(describeMicDevice({ deviceId: "a1b2c3", label: "" }, "a1b2c3")).toBe("a1b2c3");
  });
});

describe("whisper-transcribe no-input detection", () => {
  test("stays quiet inside the grace window", () => {
    expect(shouldWarnNoInput({ elapsedMs: 500, peakLevel: 0 })).toBe(false);
  });

  test("warns once a dead device has produced nothing for long enough", () => {
    expect(shouldWarnNoInput({ elapsedMs: 5000, peakLevel: 0 })).toBe(true);
  });

  test("does not mistake a quiet room for a dead device", () => {
    // Room tone from a working mic sits above the floor but far below the
    // speech threshold, so this must not warn.
    expect(shouldWarnNoInput({ elapsedMs: 30_000, peakLevel: 0.004 })).toBe(false);
  });

  test("honours explicit thresholds", () => {
    expect(shouldWarnNoInput({ elapsedMs: 1000, peakLevel: 0, graceMs: 500 })).toBe(true);
    expect(shouldWarnNoInput({ elapsedMs: 5000, peakLevel: 0.02, level: 0.5 })).toBe(true);
  });
});

describe("whisper-transcribe too-quiet detection", () => {
  // The gap that made a broken desktop recording look healthy: signal present,
  // so the silence check never fires, but never loud enough to cut a chunk, so
  // nothing is ever uploaded and no request ever fails.
  test("reports a device that is alive but never reaches speech level", () => {
    expect(shouldWarnTooQuiet({ elapsedMs: 10_000, peakLevel: 0.004, sawSpeech: false })).toBe(true);
  });

  test("stays quiet once anything has actually crossed the threshold", () => {
    expect(shouldWarnTooQuiet({ elapsedMs: 60_000, peakLevel: 0.9, sawSpeech: true })).toBe(false);
  });

  test("defers to the dead-device check for digital silence", () => {
    // Below the floor is `no input`, a different and more specific report, so
    // this must not also claim the signal is merely quiet.
    expect(shouldWarnTooQuiet({ elapsedMs: 10_000, peakLevel: 0, sawSpeech: false })).toBe(false);
  });

  test("gives the user time to start talking", () => {
    expect(shouldWarnTooQuiet({ elapsedMs: 1000, peakLevel: 0.004, sawSpeech: false })).toBe(false);
  });

  test("the two warnings are mutually exclusive at every level", () => {
    for (const peakLevel of [0, 0.0005, 0.001, 0.004, 0.02, 0.5]) {
      const args = { elapsedMs: 30_000, peakLevel, sawSpeech: false };
      expect(shouldWarnNoInput(args) && shouldWarnTooQuiet(args)).toBe(false);
    }
  });
});

describe("whisper-transcribe channel selection", () => {
  test("takes the channel carrying signal, not channel 0", () => {
    // A mic in input 2 of a stereo interface. Reading channel 0 gets an open
    // jack at its noise floor — live enough to defeat the silence check, far
    // too quiet to transcribe.
    const floor = new Float32Array(64).fill(0.002);
    const voice = new Float32Array(64).fill(0.4);
    const picked = pickLoudestChannel([floor, voice]);
    expect(picked.channel).toBe(1);
    expect(picked.level).toBeCloseTo(0.4, 3);
  });

  test("leaves a correctly wired mono input at full level", () => {
    // Averaging the pair would halve this and push it toward the threshold.
    const voice = new Float32Array(64).fill(0.4);
    const floor = new Float32Array(64).fill(0.002);
    expect(pickLoudestChannel([voice, floor]).level).toBeCloseTo(0.4, 3);
  });

  test("survives a single-channel buffer", () => {
    const picked = pickLoudestChannel([new Float32Array(64).fill(0.25)]);
    expect(picked.channel).toBe(0);
    expect(picked.level).toBeCloseTo(0.25, 3);
  });

  test("reports an empty buffer as zero rather than throwing", () => {
    expect(pickLoudestChannel([])).toEqual({ samples: null, level: 0, channel: 0 });
  });
});

describe("whisper-transcribe failure reporting", () => {
  test("distinguishes a denied prompt from a device held by another app", () => {
    expect(describeCaptureError({ name: "NotAllowedError" }).label).toBe("mic blocked");
    expect(describeCaptureError({ name: "NotReadableError", message: "in use" }).label).toBe("mic busy");
    expect(describeCaptureError({ name: "NotFoundError" }).label).toBe("no mic");
  });

  test("always yields an actionable label, even for an unknown failure", () => {
    const described = describeCaptureError(new Error("boom"));
    expect(described.label).toBe("mic failed");
    expect(described.detail).toBe("boom");
    expect(describeCaptureError(undefined).detail).toBeTruthy();
  });

  test("a self-labelled error keeps its own label instead of falling back", () => {
    // Without this, every failure() thrown on the capture path was flattened to
    // "mic failed" on its way to the chip and the specific diagnosis was lost.
    const described = describeCaptureError(failure("needs https", "not a secure context"));
    expect(described.label).toBe("needs https");
    expect(described.detail).toBe("not a secure context");
  });
});

describe("whisper-transcribe capture preconditions", () => {
  const ok = { isSecureContext: true, hasMediaDevices: true, hasGetUserMedia: true, hasAudioContext: true };

  test("a fully capable environment reports no problem", () => {
    expect(describeCaptureSupport(ok)).toBeNull();
  });

  test("an insecure origin is named as such, and outranks the missing api it causes", () => {
    // http:// on a LAN or tailnet IP removes navigator.mediaDevices entirely, so
    // checking the api first would report "no mic api" and send the user hunting
    // for a browser problem that does not exist.
    const described = describeCaptureSupport({
      ...ok, isSecureContext: false, hasMediaDevices: false, hasGetUserMedia: false,
    });
    expect(described?.label).toBe("needs https");
    expect(described?.detail).toMatch(/secure context/i);
  });

  test("an absent environment flag is not treated as insecure", () => {
    // undefined means "could not tell" — only an explicit false is a failure,
    // otherwise a non-browser environment would report a bogus https problem.
    expect(describeCaptureSupport({ ...ok, isSecureContext: undefined })).toBeNull();
  });

  test("a missing getUserMedia is distinguished from a missing AudioContext", () => {
    expect(describeCaptureSupport({ ...ok, hasGetUserMedia: false })?.label).toBe("no mic api");
    expect(describeCaptureSupport({ ...ok, hasAudioContext: false })?.label).toBe("no audio api");
  });

  test("the AudioContext message points at the webkit prefix", () => {
    // The extension constructs AudioContext unprefixed; older iOS Safari only
    // has webkitAudioContext, and that is the fix this message has to suggest.
    expect(describeCaptureSupport({ ...ok, hasAudioContext: false })?.detail).toMatch(/webkitAudioContext/);
  });

  test("meter readings are comparable against the speech threshold", () => {
    expect(levelToMeter(0)).toBe(0);
    // The dead zone the user was stuck in reads as a small but non-zero number,
    // which is the whole point — it is visibly not nothing and visibly not enough.
    expect(levelToMeter(0.004)).toBeGreaterThan(0);
    expect(levelToMeter(0.004)).toBeLessThan(levelToMeter(0.015));
    expect(levelToMeter(2)).toBe(100);
  });
});

/**
 * Minimal Web Audio / getUserMedia stubs. Only the surface
 * `createRecordingSession` actually touches is implemented; the point is to get
 * one speech-level frame through the graph, not to model audio.
 */
function installAudioStubs() {
  const processors: any[] = [];
  const scope = globalThis as any;
  const original = {
    navigator: Object.getOwnPropertyDescriptor(scope, "navigator"),
    AudioContext: scope.AudioContext,
  };

  Object.defineProperty(scope, "navigator", {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
        enumerateDevices: async () => [],
        addEventListener() {},
        removeEventListener() {},
      },
    },
  });

  scope.AudioContext = class {
    sampleRate = 48_000;
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const processor = { onaudioprocess: null as any, connect() {}, disconnect() {} };
      processors.push(processor);
      return processor;
    }
    async resume() {}
    async close() {}
  };

  return {
    /**
     * Push one frame loud enough to clear RMS_THRESHOLD and open a chunk.
     * Always targets the newest processor — each recording builds its own graph,
     * and an earlier one stays reachable after teardown.
     *
     * `channel` places the signal on one input of a stereo pair, leaving the
     * other at its noise floor. That models a multi-input interface with the
     * mic in the second jack, which is the case that used to record silence.
     */
    speak(channel = 0, amplitude = 0.5) {
      const loud = new Float32Array(4096).fill(amplitude);
      const floor = new Float32Array(4096).fill(0.003);
      const channels = channel === 0 ? [loud, floor] : [floor, loud];
      processors.at(-1)?.onaudioprocess?.({
        inputBuffer: {
          numberOfChannels: channels.length,
          getChannelData: (index: number) => channels[index],
        },
      });
    },
    restore() {
      if (original.navigator) Object.defineProperty(scope, "navigator", original.navigator);
      else delete scope.navigator;
      scope.AudioContext = original.AudioContext;
    },
  };
}

/**
 * Peak absolute amplitude of an uploaded 16-bit PCM WAV, so a test can assert
 * on the audio that was actually sent rather than trusting a stub transcript.
 * Without this, a test cannot tell a recording of the mic from a recording of
 * the empty jack next to it — both produce a chunk and both "succeed".
 */
async function peakOfUploadedWav(body: FormData): Promise<number> {
  const file = body.get("file") as Blob;
  const view = new DataView(await file.arrayBuffer());
  let peak = 0;
  for (let offset = 44; offset + 1 < view.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)) / 0x8000);
  }
  return peak;
}

function createApiStub(transcript: string, respond?: () => unknown) {
  const fallbackDrafts: string[] = [];
  const uploads: FormData[] = [];
  let action: any = null;
  const api = {
    getSettings: () => ({}),
    registerComposerAction(config: any) {
      action = { ...config, state: {} };
      return { update(next: any) { action.state = { ...action.state, ...next }; }, unregister() {} };
    },
    registerShortcut: () => () => {},
    registerSetting: () => ({ update() {}, unregister() {} }),
    request: async (_path: string, init?: { body?: FormData }) => {
      if (init?.body) uploads.push(init.body);
      return respond ? respond() : { ok: true, status: 200, text: async () => JSON.stringify({ text: transcript }) };
    },
    // The global fallbacks resolve to whichever composer registered last, which
    // is precisely what a chunk must never be routed through.
    getComposer: () => ({ draft: "" }),
    setDraft: (text: string) => { fallbackDrafts.push(text); },
    focusComposer() {},
    submitComposer() {},
  };
  return { api, fallbackDrafts, uploads, getAction: () => action };
}

function createComposerStub() {
  const drafts: string[] = [];
  return {
    drafts,
    handle: {
      getSnapshot: () => ({ draft: "", sessionId: "ses-1", cwd: "/p", userProfile: "u" }),
      focus() {},
      setDraft: (text: string) => { drafts.push(text); },
      insertText() {},
      setGhostText() {},
      submit() {},
    },
  };
}

describe("whisper-transcribe composer routing", () => {
  let audio: ReturnType<typeof installAudioStubs> | null = null;
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    audio?.restore();
    audio = null;
  });

  test("delivers a transcript to the composer that started the recording", async () => {
    audio = installAudioStubs();
    const { api, fallbackDrafts, getAction } = createApiStub("hello from the bound composer");
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const clicked = createComposerStub();
    await getAction().onClick({ composer: clicked.handle });
    audio.speak();
    await getAction().onClick({ composer: clicked.handle });

    expect(clicked.drafts).toEqual(["hello from the bound composer"]);
    // Regression guard: chunks used to be queued with a null composer, so the
    // text landed in whichever composer happened to be registered last —
    // invisible to the user who pressed the button.
    expect(fallbackDrafts).toEqual([]);
  });

  test("keeps routing to the original composer after the recording is torn down", async () => {
    audio = installAudioStubs();
    const { api, fallbackDrafts, getAction } = createApiStub("second take");
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const first = createComposerStub();
    await getAction().onClick({ composer: first.handle });
    audio.speak();
    await getAction().onClick({ composer: first.handle });

    const second = createComposerStub();
    await getAction().onClick({ composer: second.handle });
    audio.speak();
    await getAction().onClick({ composer: second.handle });

    expect(first.drafts).toEqual(["second take"]);
    expect(second.drafts).toEqual(["second take"]);
    expect(fallbackDrafts).toEqual([]);
  });

  test("uploads the channel that carries the mic, not the empty one beside it", async () => {
    audio = installAudioStubs();
    const { api, uploads, getAction } = createApiStub("input two");
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const clicked = createComposerStub();
    await getAction().onClick({ composer: clicked.handle });
    audio.speak(1);
    await getAction().onClick({ composer: clicked.handle });

    expect(clicked.drafts).toEqual(["input two"]);
    // The assertion has to be on the audio, not the transcript: a stub returns
    // text either way, so uploading the silent jack still looks like success.
    // 0.4 is the mic, 0.003 is the open input beside it.
    expect(uploads).toHaveLength(1);
    expect(await peakOfUploadedWav(uploads[0]!)).toBeGreaterThan(0.3);
  });

  test("surfaces an upstream failure on the chip instead of the console", async () => {
    audio = installAudioStubs();
    const { api, getAction } = createApiStub("", () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: "whisper transcription failed", details: "model 'whisper-1' not found" }),
    }));
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const clicked = createComposerStub();
    await getAction().onClick({ composer: clicked.handle });
    audio.speak();
    await getAction().onClick({ composer: clicked.handle });
    // The reporting hop rides the rejection handler, which settles a tick after
    // the upload chain the stop path awaits.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clicked.drafts).toEqual([]);
    const status = getAction().state.status;
    expect(status?.tone).toBe("error");
    expect(status?.label).toBe("whisper 502");
    // The upstream reason has to reach the user; it is the whole diagnostic.
    expect(getAction().state.title).toContain("model 'whisper-1' not found");
  });

  test("clears a stale failure when the next recording starts", async () => {
    audio = installAudioStubs();
    let fail = true;
    const { api, getAction } = createApiStub("recovered", () => (fail
      ? { ok: false, status: 502, text: async () => JSON.stringify({ error: "nope" }) }
      : { ok: true, status: 200, text: async () => JSON.stringify({ text: "recovered" }) }));
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const clicked = createComposerStub();
    await getAction().onClick({ composer: clicked.handle });
    audio.speak();
    await getAction().onClick({ composer: clicked.handle });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getAction().state.status?.tone).toBe("error");

    fail = false;
    await getAction().onClick({ composer: clicked.handle });
    expect(getAction().state.status?.tone).toBe("active");
  });
});

describe("whisper-transcribe request shape", () => {
  let audio: ReturnType<typeof installAudioStubs> | null = null;
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    audio?.restore();
    audio = null;
  });

  /**
   * The desktop shell runs on a different origin from the backend, so any
   * custom request header forces a CORS preflight. When that preflight does not
   * allow the header the browser drops the request before sending it: nothing
   * is logged on either side and the feature is silently dead. This is exactly
   * how STT stayed broken on the desktop while working from a phone, which is
   * same-origin. Config must ride in the body, not in custom headers.
   */
  test("sends no custom request headers, so no CORS preflight allowance is needed", async () => {
    audio = installAudioStubs();
    const seen: Array<Record<string, unknown>> = [];
    const { api, getAction } = createApiStub("ok");
    // A whisperUrl must be configured or there is nothing that could become a
    // header, and the assertion would hold no matter how the code sends it.
    (api as any).getSettings = () => ({ whisperUrl: "http://box:8080/v1/audio/transcriptions" });
    const original = api.request;
    (api as any).request = async (path: string, init: any) => {
      seen.push(init?.headers ?? {});
      return original(path, init);
    };
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const clicked = createComposerStub();
    await getAction().onClick({ composer: clicked.handle });
    audio.speak();
    await getAction().onClick({ composer: clicked.handle });

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] ?? {})).toEqual([]);
  });

  test("carries the configured whisper url as a form field", async () => {
    audio = installAudioStubs();
    const { api, uploads, getAction } = createApiStub("ok");
    (api as any).getSettings = () => ({ whisperUrl: "http://box:8080/v1/audio/transcriptions" });
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const clicked = createComposerStub();
    await getAction().onClick({ composer: clicked.handle });
    audio.speak();
    await getAction().onClick({ composer: clicked.handle });

    expect(uploads[0]?.get("whisperUrl")).toBe("http://box:8080/v1/audio/transcriptions");
  });

  test("an unreachable harness reads as a connection failure, not a transcription failure", async () => {
    audio = installAudioStubs();
    const { api, getAction } = createApiStub("");
    (api as any).request = async () => { throw new TypeError("Failed to fetch"); };
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const clicked = createComposerStub();
    await getAction().onClick({ composer: clicked.handle });
    audio.speak();
    await getAction().onClick({ composer: clicked.handle });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = getAction().state.status;
    expect(status?.tone).toBe("error");
    expect(status?.label).toBe("no connection");
    expect(getAction().state.title).toContain("never reached the harness");
  });

  test("an HTTP error names its status on the chip", async () => {
    audio = installAudioStubs();
    const { api, getAction } = createApiStub("", () => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => JSON.stringify({ error: "whisper transcription failed", details: "connection refused" }),
    }));
    dispose = whisperTranscribeExtension(api as any) as () => void;

    const clicked = createComposerStub();
    await getAction().onClick({ composer: clicked.handle });
    audio.speak();
    await getAction().onClick({ composer: clicked.handle });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAction().state.status?.label).toBe("whisper 502");
    expect(getAction().state.title).toContain("connection refused");
  });
});
