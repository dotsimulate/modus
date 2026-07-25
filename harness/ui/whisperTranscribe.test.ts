import { afterEach, describe, expect, test } from "bun:test";
import whisperTranscribeExtension, {
  describeMicDevice,
  matchAudioInputDevice,
  shouldWarnNoInput,
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
     */
    speak() {
      const samples = new Float32Array(4096).fill(0.5);
      processors.at(-1)?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
    },
    restore() {
      if (original.navigator) Object.defineProperty(scope, "navigator", original.navigator);
      else delete scope.navigator;
      scope.AudioContext = original.AudioContext;
    },
  };
}

function createApiStub(transcript: string) {
  const fallbackDrafts: string[] = [];
  let action: any = null;
  const api = {
    getSettings: () => ({}),
    registerComposerAction(config: any) {
      action = { ...config, state: {} };
      return { update(next: any) { action.state = { ...action.state, ...next }; }, unregister() {} };
    },
    registerShortcut: () => () => {},
    registerSetting: () => ({ update() {}, unregister() {} }),
    request: async () => ({ ok: true, json: async () => ({ text: transcript }) }),
    // The global fallbacks resolve to whichever composer registered last, which
    // is precisely what a chunk must never be routed through.
    getComposer: () => ({ draft: "" }),
    setDraft: (text: string) => { fallbackDrafts.push(text); },
    focusComposer() {},
    submitComposer() {},
  };
  return { api, fallbackDrafts, getAction: () => action };
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
});
