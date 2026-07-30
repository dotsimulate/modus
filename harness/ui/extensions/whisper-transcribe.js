console.log("[Whisper] Loading extension... version 2.11");
const SHORTCUT = "Ctrl+Shift+~";
const BUFFER_SIZE = 4096;
const RMS_THRESHOLD = 0.015;
const SILENCE_MS = 1000;
const MIN_CHUNK_MS = 2000;
const MAX_CHUNK_MS = 30000;
const PRE_ROLL_MS = 250;
// A dead or hardware-muted capture device produces digital silence. A live mic
// in a quiet room still floats well above this, so it separates "no signal at
// all" from "nobody is talking" — the distinction RMS_THRESHOLD cannot make.
const NO_INPUT_LEVEL = 0.001;
const NO_INPUT_GRACE_MS = 4000;
// Between NO_INPUT_LEVEL and RMS_THRESHOLD is a dead zone: the device is
// plainly alive, but nothing ever crosses the speech threshold, so no chunk is
// ever cut and no request is ever sent. Left unreported that state is
// indistinguishable from "recording normally" — the chip just says recording
// forever. This is the grace period before we call it out.
const TOO_QUIET_GRACE_MS = 6000;
// Multi-channel interfaces (a MOTU 1-2, a Scarlett, any two-input box) put the
// mic on whichever jack the user plugged into. Reading only channel 0 means a
// mic in input 2 records an open jack at its noise floor — live enough to
// defeat the silence check, far too quiet to transcribe. Capture both and use
// whichever channel actually carries signal.
const CAPTURE_CHANNELS = 2;
const SEND_TRIGGER_RE = /(?:^|[\s"'([{])(send it now|send it|send now|send this|send the message|submit(?: the)? message)\s*["'"')\].,!?\s]*$/i;

const TRIGGER_WINDOW_WORDS = 4;

const TRIGGERS = {
  "scrap that": "clear_last",
  "scrap it": "clear_last",
  "toss that": "clear_last",
  "wipe slate": "clear_all",
  "clear slate": "clear_all",
  "clear all": "clear_all",
  "recall swap": "recall_swap",
  "stop listening to me": "gate_close",
  "start listening to me": "gate_open",
};

const AVOID_PHRASES = [
  /^(thank you|thanks)\.?$/i,
  /^(ok|okay)\.?$/i,
  /^(um+|uh+|hmm+|mm+)\.?$/i,
  /^(you)\.?$/i,
  /^(bye|goodbye)\.?$/i,
  /^\.$/,
];

function isAvoidPhrase(text) {
  const normalized = normalizeLooseText(text);
  return AVOID_PHRASES.some((re) => re.test(normalized));
}

function normalizeTranscript(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function trimSendTrigger(text) {
  const value = String(text ?? "");
  const next = value.replace(SEND_TRIGGER_RE, "").trimEnd();
  return next === value ? null : next;
}

function normalizeLooseText(text) {
  return normalizeTranscript(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchTrigger(normalizedText) {
  const text = normalizedText;
  if (!text) return null;

  const textWords = text.split(" ");

  for (const [phrase, command] of Object.entries(TRIGGERS)) {
    const phraseWords = phrase.split(" ");
    if (phraseWords.length > textWords.length) continue;

    for (let startPos = 0; startPos <= 3 && startPos + phraseWords.length <= textWords.length; startPos++) {
      const window = textWords.slice(startPos, startPos + phraseWords.length).join(" ");
      if (window === phrase) {
        return { command, confidence: 1.0, phrase, startPos };
      }
    }
  }

  return null;
}

function estimateDurationMs(sampleCount, sampleRate) {
  if (!sampleRate) return 0;
  return (sampleCount / sampleRate) * 1000;
}

function calculateLevel(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Pick the input channel actually carrying signal.
 *
 * Averaging channels would halve a mono source that only occupies one of them,
 * pushing a usable mic further toward the speech threshold; summing would clip.
 * Taking the loudest is the only mix that leaves a correctly-wired mono input
 * at full level regardless of which jack it landed on.
 */
export function pickLoudestChannel(channels) {
  let best = null;
  let bestLevel = -1;
  let bestIndex = 0;
  for (let i = 0; i < channels.length; i++) {
    const level = calculateLevel(channels[i]);
    if (level > bestLevel) {
      bestLevel = level;
      best = channels[i];
      bestIndex = i;
    }
  }
  return { samples: best, level: bestLevel < 0 ? 0 : bestLevel, channel: bestIndex };
}

/** Peak level as a 0-100 meter reading, so the chip can show a real number. */
export function levelToMeter(level) {
  return Math.min(100, Math.round(level * 100 * 10) / 10);
}

function mergeSamples(chunks, totalLength) {
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Resolve a configured microphone preference against a device list. Exact
 * deviceId first, then a case-insensitive label substring, so the user can
 * paste either the opaque id or any recognizable chunk of the device name.
 * Returns null when nothing matches — callers fall back to the system default
 * and say so, rather than silently recording the wrong input.
 */
export function matchAudioInputDevice(devices, preference) {
  const wanted = String(preference ?? "").trim();
  if (!wanted) return null;
  const inputs = (devices ?? []).filter((device) => device?.kind === "audioinput");
  const exact = inputs.find((device) => device.deviceId === wanted);
  if (exact) return exact;
  const needle = wanted.toLowerCase();
  return inputs.find((device) => String(device.label ?? "").toLowerCase().includes(needle)) ?? null;
}

/**
 * Whether a recording has gone long enough with no measurable signal to call
 * the capture device dead. Silence alone is not enough — the user may simply
 * not be speaking yet — so this only fires once the grace window has elapsed.
 */
export function shouldWarnNoInput({ elapsedMs, peakLevel, graceMs = NO_INPUT_GRACE_MS, level = NO_INPUT_LEVEL }) {
  return elapsedMs >= graceMs && peakLevel < level;
}

/**
 * Whether the capture graph has never delivered a single audio frame.
 *
 * A different fault from silence, needing a different message. An AudioContext
 * that stays suspended never fires `onaudioprocess` at all — the normal outcome
 * on iOS Safari, where the context is constructed after getUserMedia's
 * permission round-trip and transient user activation is therefore already gone,
 * so `resume()` resolves without changing state. Level then sits at exactly zero
 * forever, which `shouldWarnNoInput` reads as a dead microphone and blames
 * hardware that is working perfectly.
 */
export function shouldWarnNoFrames({ elapsedMs, frames, graceMs = NO_INPUT_GRACE_MS }) {
  return elapsedMs >= graceMs && frames <= 0;
}

/**
 * Whether a recording is alive but has never been loud enough to transcribe.
 *
 * This is the gap `shouldWarnNoInput` cannot see. A device sitting between the
 * silence floor and the speech threshold — an open jack on an interface, a mic
 * on the wrong input, a channel with the gain down — never opens a chunk, so
 * nothing is ever uploaded and nothing ever fails. The recording just runs, and
 * reports itself healthy, indefinitely.
 */
export function shouldWarnTooQuiet({
  elapsedMs,
  peakLevel,
  sawSpeech,
  graceMs = TOO_QUIET_GRACE_MS,
  floor = NO_INPUT_LEVEL,
}) {
  return !sawSpeech && elapsedMs >= graceMs && peakLevel >= floor;
}

/**
 * Turn a getUserMedia rejection into something a user can act on.
 *
 * The raw DOMException names are the only signal distinguishing "you denied the
 * prompt" from "the interface is claimed by your DAW", and both look identical
 * from the composer otherwise — the recording simply never starts.
 */
/**
 * An error carrying its own chip label, so the status shows what kind of
 * failure it was ("no connection", "whisper 502") rather than one generic
 * string for every cause.
 */
export function failure(label, detail) {
  const error = new Error(detail);
  error.label = label;
  return error;
}

export function describeCaptureError(error) {
  const name = error?.name ?? "";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  // An error that already carries its own chip label (from failure()) has
  // diagnosed itself more precisely than a DOMException name ever could. Without
  // this, every such error fell through to the "mic failed" default and the
  // specific message was discarded on its way to the chip.
  if (typeof error?.label === "string" && error.label) {
    return { label: error.label, detail: raw || error.label };
  }
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return { label: "mic blocked", detail: "Microphone permission was denied for this window. Allow it and try again." };
    case "NotFoundError":
      return { label: "no mic", detail: "No audio input device is available to this client." };
    case "NotReadableError":
    case "AbortError":
      return { label: "mic busy", detail: `The audio device could not be opened — another application may hold it exclusively. (${raw})` };
    case "OverconstrainedError":
      return { label: "mic unusable", detail: `The selected device rejected the requested capture format. (${raw})` };
    default:
      return { label: "mic failed", detail: raw || "The microphone could not be opened." };
  }
}

/** Short human label for whichever input actually ended up live. */
export function describeMicDevice(device, preference) {
  if (device) return device.label || device.deviceId || "selected mic";
  const wanted = String(preference ?? "").trim();
  return wanted ? `system default (no match for "${wanted}")` : "system default";
}

/**
 * Whether a throwaway stream is the only way to evaluate a label preference.
 *
 * Only worth a permission round-trip when there is something to match and every
 * label is hidden. An empty list means this browser will not name devices at
 * all, and the real capture below produces a better error than a probe would.
 */
export function needsLabelProbe(inputs) {
  const list = inputs ?? [];
  return list.length > 0 && list.every((device) => !device?.label);
}

async function enumerateAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}

/**
 * Resolve the configured mic preference.
 *
 * Returns `missing: true` when a preference was set and matched nothing, which
 * is a reportable condition rather than a silent fallback: a deviceId is scoped
 * to the origin that enumerated it, so an id saved from a phone browser can
 * never match inside the desktop shell and vice versa. Falling back to the
 * system default without saying so is how a mic setting silently stops meaning
 * anything.
 *
 * Returns the probe stream when one was taken and nothing matched, because that
 * stream is already exactly what the system-default path would ask for. Handing
 * it back is what keeps the common phone case to a single getUserMedia call:
 * stopping a stream and immediately opening another is a known way to get a
 * silent or failing capture on iOS Safari, and a label saved on one client can
 * never match on another, so that path is reached every single time.
 */
async function resolveMicDevice(preference) {
  const wanted = String(preference ?? "").trim();
  if (!wanted) return { device: null, requested: "", missing: false, stream: null };

  let inputs = await enumerateAudioInputs();
  // Device labels stay blank until the page has held a mic stream at least
  // once, so a label preference cannot match on a cold start. Take a default
  // stream to unlock them, then look again — and keep it.
  let stream = null;
  if (needsLabelProbe(inputs)) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      inputs = await enumerateAudioInputs();
    } catch {
      // Fall through and match against whatever we could see.
    }
  }

  const match = matchAudioInputDevice(inputs, wanted);
  if (match && stream) {
    // A named device needs its own constraint set, so this stream is no use.
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (!match) {
    console.warn(
      `[whisper-transcribe] no audio input matched "${wanted}" — using the system default.`,
      `Available: ${inputs.map((device) => device.label || device.deviceId).join(" | ") || "(none)"}`,
    );
  }
  return { device: match, requested: wanted, missing: !match, stream };
}

/**
 * Say which capture precondition is missing, rather than one message for all of
 * them.
 *
 * These fail for unrelated reasons and need unrelated fixes, but they used to
 * collapse into "browser audio capture is not available" — which on the chip
 * read as the generic "mic failed" and told the user nothing they could act on.
 * The packaged desktop has no devtools and a phone has no console at all, so
 * this string is the entire diagnosis.
 *
 * Takes an environment snapshot rather than reading globals so it is testable.
 */
export function describeCaptureSupport(env) {
  // Browsers expose getUserMedia only in a secure context. Loopback and https
  // qualify; a plain http:// origin on a LAN or tailnet IP does not, and
  // navigator.mediaDevices is then simply absent — indistinguishable from an
  // ancient browser unless we check this first.
  if (env.isSecureContext === false) {
    return {
      label: "needs https",
      detail: "Microphone access requires a secure context. This page was loaded over plain http, so the browser hides the microphone entirely. Reach Modus over https (Tailscale Serve provides it) or on localhost.",
    };
  }
  if (!env.hasMediaDevices || !env.hasGetUserMedia) {
    return {
      label: "no mic api",
      detail: "This browser exposes no navigator.mediaDevices.getUserMedia, so audio cannot be captured here.",
    };
  }
  if (!env.hasAudioContext) {
    return {
      label: "no audio api",
      detail: "This browser exposes no unprefixed AudioContext, so the capture graph cannot be built. Older iOS Safari only provides webkitAudioContext.",
    };
  }
  return null;
}

function captureSupportFromGlobals() {
  return describeCaptureSupport({
    // Absent in a non-browser test environment; only an explicit false is a failure.
    isSecureContext: typeof window === "undefined" ? undefined : window.isSecureContext,
    hasMediaDevices: !!navigator.mediaDevices,
    hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
    hasAudioContext: typeof AudioContext !== "undefined",
  });
}

async function createRecordingSession(micPreference) {
  const unsupported = captureSupportFromGlobals();
  if (unsupported) throw failure(unsupported.label, unsupported.detail);

  const { device, requested, missing, stream: probeStream } = await resolveMicDevice(micPreference);
  // An explicitly chosen device means the user knows their hardware, so ask for
  // it raw: Chromium's default processing chain (echo cancellation especially)
  // forces a multi-channel interface down to mono channel 0, which loses a mic
  // plugged into the second input. The system-default path keeps the processing,
  // where it is usually a laptop mic that benefits from it.
  const constraints = device
    ? {
        audio: {
          deviceId: { exact: device.deviceId },
          channelCount: { ideal: CAPTURE_CHANNELS },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      }
    : { audio: true };
  // A probe stream only survives resolution when no device matched, and the
  // constraints for that case are `{ audio: true }` — the probe's own. So this
  // is a reuse, not a shortcut, and it avoids a second getUserMedia entirely.
  let stream = device ? null : probeStream;
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      // Not every interface honours the raw constraint set. Retry bare rather
      // than reporting a dead mic for what is only an unsupported constraint.
      if (!device) throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: device.deviceId } } });
    }
  }
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(BUFFER_SIZE, CAPTURE_CHANNELS, 1);
  const preRollLimit = Math.max(1, Math.round((context.sampleRate * PRE_ROLL_MS) / 1000));
  let preRollChunks = [];
  let preRollLength = 0;
  let chunkChunks = [];
  let chunkLength = 0;
  let chunkHasSpeech = false;
  let silenceMs = 0;
  let closed = false;
  let peakLevel = 0;
  let recentPeak = 0;
  let sawSpeech = false;
  // Counted rather than inferred: zero frames and silent frames look identical
  // in the level, and they have opposite causes.
  let frames = 0;
  let liveChannel = 0;
  const startedAt = Date.now();

  async function closeGraph() {
    if (closed) return;
    closed = true;
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
  }

  function resetChunk() {
    chunkChunks = [];
    chunkLength = 0;
    chunkHasSpeech = false;
    silenceMs = 0;
  }

  function trimPreRoll() {
    while (preRollLength > preRollLimit && preRollChunks.length > 0) {
      const removed = preRollChunks.shift();
      preRollLength -= removed?.length ?? 0;
    }
  }

  function pushPreRoll(chunk) {
    preRollChunks.push(chunk);
    preRollLength += chunk.length;
    trimPreRoll();
  }

  function beginChunk() {
    chunkChunks = preRollChunks.slice();
    chunkLength = preRollLength;
    chunkHasSpeech = false;
    silenceMs = 0;
  }

  function takeChunk(force = false, preservePreRoll = true) {
    if (chunkLength === 0) return null;
    const durationMs = estimateDurationMs(chunkLength, context.sampleRate);
    if (!force && durationMs < MIN_CHUNK_MS) return null;
    const blob = encodeWav(mergeSamples(chunkChunks, chunkLength), context.sampleRate);
    resetChunk();
    if (!preservePreRoll) {
      preRollChunks = [];
      preRollLength = 0;
    }
    return blob;
  }

  processor.onaudioprocess = (event) => {
    frames += 1;
    const buffer = event.inputBuffer;
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    const picked = pickLoudestChannel(channels);
    const input = picked.samples ?? channels[0];
    const copy = new Float32Array(input.length);
    copy.set(input);

    const level = picked.level;
    if (level > peakLevel) {
      peakLevel = level;
      liveChannel = picked.channel;
    }
    // Decaying peak so the chip's meter tracks what is happening now rather
    // than the loudest thing that ever happened.
    recentPeak = Math.max(level, recentPeak * 0.85);
    const isSpeech = level >= RMS_THRESHOLD;
    if (isSpeech) sawSpeech = true;
    const frameMs = estimateDurationMs(copy.length, context.sampleRate);

    if (chunkLength === 0) {
      if (!isSpeech) {
        pushPreRoll(copy);
        return;
      }
      beginChunk();
    }

    chunkChunks.push(copy);
    chunkLength += copy.length;
    pushPreRoll(copy);

    if (isSpeech) {
      chunkHasSpeech = true;
      silenceMs = 0;
    } else {
      silenceMs += frameMs;
    }
  };

  source.connect(processor);
  processor.connect(context.destination);
  await context.resume();

  return {
    device,
    deviceLabel: describeMicDevice(device, micPreference),
    /** Set when a mic preference was configured but matched no device here. */
    missingPreference: missing ? requested : null,
    /** Live 0-100 meter reading, so "is it hearing anything" is answerable. */
    meter() {
      return levelToMeter(recentPeak);
    },
    /** Which input channel is carrying the signal — 1-based for humans. */
    channel() {
      return liveChannel + 1;
    },
    /** True once the capture device has produced nothing for the grace window. */
    isSilent() {
      return shouldWarnNoInput({ elapsedMs: Date.now() - startedAt, peakLevel });
    },
    /**
     * True when the graph has never delivered a frame at all — a suspended or
     * dead AudioContext rather than a silent microphone. Checked before
     * isSilent(), which would otherwise blame the hardware.
     */
    isStalled() {
      return shouldWarnNoFrames({ elapsedMs: Date.now() - startedAt, frames });
    },
    /** Raw AudioContext state, so a stalled graph can name its own cause. */
    contextState() {
      return context.state;
    },
    /**
     * Alive but never loud enough to cut a chunk. Without this the recording
     * runs forever, uploads nothing, and reports success the whole time.
     */
    isTooQuiet() {
      return shouldWarnTooQuiet({ elapsedMs: Date.now() - startedAt, peakLevel, sawSpeech });
    },
    takeReadyChunk() {
      if (chunkLength === 0) return null;
      const durationMs = estimateDurationMs(chunkLength, context.sampleRate);
      if (durationMs >= MAX_CHUNK_MS) {
        return takeChunk(true, false);
      }
      if (chunkHasSpeech && durationMs >= MIN_CHUNK_MS && silenceMs >= SILENCE_MS) {
        return takeChunk(true);
      }
      return null;
    },
    async stop() {
      await closeGraph();
      return takeChunk(true, false);
    },
    async dispose() {
      await closeGraph();
      resetChunk();
      preRollChunks = [];
      preRollLength = 0;
    },
  };
}

function isDesktop() {
  try {
    return window.matchMedia("(pointer: fine) and (min-width: 768px)").matches;
  } catch {
    return false;
  }
}

export default function whisperTranscribeExtension(api) {
  const settings = api.getSettings();
  let recording = null;
  // The composer whose mic button started this recording. Chunks flush from a
  // timer, long after the click, and api.setDraft() resolves to whichever
  // composer registered last — so transcripts would land in an unrelated
  // session. Hold the handle for the life of the recording instead. It is a
  // live proxy, so it survives remounts.
  let activeComposer = null;
  let pendingUploads = 0;
  let disposed = false;
  let uploadChain = Promise.resolve();
  let chunkTimer = null;
  let typingTimer = null;
  let intendedDraft = null;
  let isGated = false;
  let lastAddedChunks = [];
  let clearedBuffer = "";
  // Sticky failure text. The packaged desktop has no devtools, so a console
  // line is not a report — anything the user needs to act on has to survive on
  // the chip after the recording that produced it has ended. Cleared when the
  // next recording starts.
  let lastError = null;

  function reportError(label, detail) {
    lastError = { label, detail: detail ?? label };
    console.error(`[whisper-transcribe] ${label}: ${detail ?? label}`);
    syncAction();
  }

  const action = api.registerComposerAction({
    id: "mic",
    icon: "mic",
    title: "Start voice transcription",
    onClick: async ({ composer }) => {
      await toggleRecording(composer);
    },
  });

  function syncAction() {
    const finishing = !recording && pendingUploads > 0;
    const stalled = !!recording && recording.isStalled();
    const noInput = !!recording && !stalled && recording.isSilent();
    const tooQuiet = !!recording && !stalled && !noInput && recording.isTooQuiet();
    const missingMic = recording?.missingPreference ?? null;
    let label = null;
    let tone = null;
    let title = "Start voice transcription";

    if (recording) {
      // The meter rides along on every recording state. "Is it hearing me" is
      // the first question every microphone failure raises, and a number
      // answers it without a console.
      const meter = recording.meter();
      const micSuffix = ` — mic: ${recording.deviceLabel}, ch ${recording.channel()}, level ${meter}`;
      if (stalled) {
        // The browser handed over a microphone and then never ran the graph.
        // Distinct from silence, and the fix is unrelated to the hardware.
        label = "audio stalled";
        tone = "error";
        title = `The microphone opened but the browser delivered no audio at all — its audio engine is "${recording.contextState()}", not running. On iOS Safari this happens when the page loses user activation before the audio graph starts: stop, then tap the mic button again.`;
      } else if (noInput) {
        // Digital silence: the device is dead, muted, or not the one recording.
        label = "no input";
        tone = "error";
        title = `No audio at all from ${recording.deviceLabel}. The device is muted or not capturing.`;
      } else if (tooQuiet) {
        // The dead zone. Signal is present but never crosses the speech
        // threshold, so no chunk is ever cut and nothing is ever uploaded —
        // previously identical to "recording" and reported forever.
        label = `too quiet · ${meter}`;
        tone = "error";
        title = `${recording.deviceLabel} is producing signal on channel ${recording.channel()} but never loud enough to transcribe (level ${meter}, needs ~${levelToMeter(RMS_THRESHOLD)}). Check the input gain, or whether the mic is on a different input than the one being captured.`;
      } else if (isGated) {
        label = `say "start listening to me"`;
        tone = "gated";
        title = `Transcription paused (say start listening to me)${micSuffix}`;
      } else if (missingMic) {
        // Not a failure: the recording is live on the system default. Reporting
        // it as an error hid the live meter for the whole session and sent the
        // user hunting for a broken microphone. A mic chosen on one client can
        // never resolve on another, so on a phone this is the ordinary path.
        label = `default mic · ${meter}`;
        tone = "active";
        title = `No input matched "${missingMic}" on this client, so the system default is being recorded${micSuffix}. A mic chosen in another browser or on another device cannot resolve here.`;
      } else {
        label = `recording · ${meter}`;
        tone = "active";
        title = `Stop voice recording${micSuffix}`;
      }
    } else if (finishing) {
      label = "finishing";
      tone = "busy";
      title = "Finishing voice transcription";
    } else if (lastError) {
      // Survives the recording that produced it, so a failed upload is still
      // on screen when the user looks down.
      label = lastError.label;
      tone = "error";
      title = `${lastError.detail} — click the mic to try again.`;
    }

    action.update({
      title,
      disabled: finishing,
      status: label ? { label, tone } : null,
    });
  }

  function clearChunkTimer() {
    if (!chunkTimer) return;
    clearInterval(chunkTimer);
    chunkTimer = null;
  }

  function cancelTyping() {
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
    intendedDraft = null;
  }

  function flushTyping(composer) {
    if (intendedDraft !== null) {
      if (composer) composer.setDraft(intendedDraft);
      else api.setDraft(intendedDraft);
    }
    cancelTyping();
  }

  function typeInto(composer, base, addition, fullDraft, onDone) {
    cancelTyping();
    intendedDraft = fullDraft;

    const useWords = addition.trim().split(/\s+/).length > 4 || addition.length > 50;
    const tokens = useWords
      ? addition.match(/\S+\s*/g) ?? [addition]
      : addition.split("");
    const DELAY = useWords ? 55 : 22;

    let i = 0;
    let built = "";
    function tick() {
      if (disposed) return;
      built += tokens[i];
      i++;
      const partial = base + built;
      if (composer) composer.setDraft(partial);
      else api.setDraft(partial);
      if (i < tokens.length) {
        typingTimer = setTimeout(tick, DELAY);
      } else {
        typingTimer = null;
        intendedDraft = null;
        onDone?.();
      }
    }
    typingTimer = setTimeout(tick, DELAY);
  }

  function appendTranscript(composer, text) {
    if (!text || disposed) return;
    const normalized = normalizeLooseText(text);

    const trigger = matchTrigger(normalized);
    if (trigger) {
      if (trigger.command === "gate_close") {
        isGated = true;
        syncAction();
        return;
      }
      if (trigger.command === "gate_open") {
        isGated = false;
        syncAction();
        return;
      }
      if (trigger.command === "clear_all") {
        const currentDraftForClear = intendedDraft ?? (composer ? composer.getSnapshot().draft : api.getComposer()?.draft ?? "");
        clearedBuffer = currentDraftForClear;
        if (composer) composer.setDraft("");
        else api.setDraft("");
        lastAddedChunks = [];
        return;
      }
      if (trigger.command === "recall_swap") {
        const currentDraftForSwap = intendedDraft ?? (composer ? composer.getSnapshot().draft : api.getComposer()?.draft ?? "");
        const restored = clearedBuffer;
        clearedBuffer = currentDraftForSwap;
        if (composer) composer.setDraft(restored);
        else api.setDraft(restored);
        return;
      }
      if (trigger.command === "clear_last") {
        const last = lastAddedChunks.pop();
        if (last) {
          if (composer) composer.setDraft(last.draftBeforeAction);
          else api.setDraft(last.draftBeforeAction);
        }
        return;
      }
    }

    if (isGated) return;

    const currentDraft = intendedDraft ?? (composer ? composer.getSnapshot().draft : api.getComposer()?.draft ?? "");
    if (isAvoidPhrase(text)) return;

    const snapshotBefore = currentDraft;

    const submit = (nextDraft) => {
      flushTyping(composer);
      if (composer) {
        composer.setDraft(nextDraft);
        composer.focus();
        composer.submit(nextDraft);
        return;
      }
      api.setDraft(nextDraft);
      api.focusComposer();
      api.submitComposer(nextDraft);
    };

    const spacer = currentDraft && !/\s$/.test(currentDraft) ? " " : "";
    const addition = spacer + text;
    const nextDraft = currentDraft + addition;
    const trimmedDraft = trimSendTrigger(nextDraft);

    if (trimmedDraft !== null) {
      submit(trimmedDraft);
      return;
    }

    lastAddedChunks.push({ text: addition, draftBeforeAction: snapshotBefore });
    if (lastAddedChunks.length > 20) lastAddedChunks.shift();

    if (isDesktop()) {
      typeInto(composer, currentDraft, addition, nextDraft, () => composer?.focus() || api.focusComposer());
    } else {
      if (composer) {
        composer.setDraft(nextDraft);
        composer.focus();
      } else {
        api.setDraft(nextDraft);
        api.focusComposer();
      }
    }
  }

  async function transcribe(blob, composer) {
    const file = new File([blob], `recording-${Date.now()}.wav`, { type: "audio/wav" });
    const body = new FormData();
    body.set("file", file);
    if (settings.model) body.set("model", String(settings.model));
    if (settings.language) body.set("language", String(settings.language));
    // A form field, not a custom header. The desktop shell is a different origin
    // from the backend, so a custom header forces a CORS preflight — and when
    // that preflight does not allow the header the browser drops the request
    // before it is sent, logging nothing on either side.
    if (settings.whisperUrl) body.set("whisperUrl", String(settings.whisperUrl));

    // The API key is never held here — the harness resolves whisperSecretName
    // from its own secret store, so it needs to know which settings scope to
    // read. Both are advisory: the server merges its own configured defaults.
    const snapshot = composer ? composer.getSnapshot() : api.getComposer();
    const query = new URLSearchParams();
    if (snapshot?.cwd) query.set("cwd", snapshot.cwd);
    if (snapshot?.userProfile) query.set("userProfile", snapshot.userProfile);
    const suffix = query.toString();

    const path = `/api/whisper/transcribe${suffix ? `?${suffix}` : ""}`;
    let response;
    try {
      response = await api.request(path, { method: "POST", body });
    } catch (cause) {
      // The request never left the browser: CORS, offline, or the backend
      // moved. Distinguished from an HTTP error because there is no status —
      // and because nothing is logged server-side, so the chip is the only
      // place this can ever be seen.
      throw failure("no connection", `the request never reached the harness (${cause?.message ?? cause})`);
    }

    // Read as text first: an error response is not always JSON, and .json()
    // throwing would have discarded the status along with the body.
    const raw = await response.text().catch(() => "");
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }

    if (!response.ok) {
      const detail = payload?.details || payload?.error || raw.slice(0, 300) || response.statusText || "no response body";
      throw failure(`whisper ${response.status}`, detail);
    }

    const text = normalizeTranscript(payload?.text);
    appendTranscript(composer, text);
  }

  function queueTranscription(blob, composer) {
    pendingUploads++;
    syncAction();

    const task = uploadChain.then(async () => {
      await transcribe(blob, composer);
    });

    uploadChain = task.catch(() => {});

    task
      .catch((error) => {
        // Previously a console-only line, which in the packaged desktop meant
        // an upstream 502 — a wrong model, an unreachable endpoint, a rejected
        // key — was completely invisible.
        const message = error instanceof Error ? error.message : String(error);
        reportError(error?.label ?? "transcribe failed", message);
      })
      .finally(() => {
        pendingUploads = Math.max(0, pendingUploads - 1);
        syncAction();
      });

    return task;
  }

  function flushReadyChunk() {
    if (!recording || disposed) return;
    // The chip carries a live meter now, so it re-syncs on every tick rather
    // than only when the silence flag flips. 4Hz while recording only.
    syncAction();
    const blob = recording.takeReadyChunk();
    if (!blob || blob.size === 0) return;
    queueTranscription(blob, activeComposer);
  }

  async function toggleRecording(composer) {
    if (!recording && pendingUploads > 0) return;

    if (recording) {
      const activeRecording = recording;
      recording = null;
      clearChunkTimer();
      syncAction();
      try {
        const wavBlob = await activeRecording.stop();
        if (!disposed && wavBlob && wavBlob.size > 0) {
          queueTranscription(wavBlob, activeComposer);
        }
      } catch (error) {
        reportError("recording failed", error instanceof Error ? error.message : String(error));
      } finally {
        await uploadChain;
        activeComposer = null;
        isGated = false;
        syncAction();
      }
      return;
    }

    if (!composer) return;

    try {
      lastError = null;
      recording = await createRecordingSession(settings.micDevice);
      activeComposer = composer;
      chunkTimer = setInterval(flushReadyChunk, 250);
      isGated = false;
      syncAction();
      // Holding a stream unlocks device labels — republish so the settings
      // dropdown shows names instead of opaque ids from here on.
      void publishMicOptions();
    } catch (error) {
      recording = null;
      activeComposer = null;
      const described = describeCaptureError(error);
      reportError(described.label, described.detail);
    }
  }

  const unregister = api.registerShortcut(SHORTCUT, async ({ getComposer }) => {
    await toggleRecording(getComposer());
  });

  // Audio devices only exist in the browser, so the sidecar manifest cannot
  // list them. Publish them live instead, and refresh when hardware changes.
  const micSetting = api.registerSetting?.("micDevice", {
    options: [],
    emptyLabel: "system default",
  });

  async function publishMicOptions() {
    if (!micSetting || disposed) return;
    const inputs = await enumerateAudioInputs().catch(() => []);
    micSetting.update({
      // Store the LABEL, not the deviceId. A deviceId is scoped to the origin
      // that enumerated it, and this setting lives in one user profile shared
      // by every client — the desktop shell at http://tauri.localhost and any
      // browser reaching the harness over the network are different origins,
      // so an id chosen in one can never resolve in the other. Labels are
      // stable device names and matchAudioInputDevice already resolves them by
      // substring, with exact-id matching tried first so ids saved by earlier
      // versions keep working where they were saved.
      options: inputs.map((device) => ({
        value: device.label || device.deviceId,
        // Labels stay blank until the page has held a mic stream once; the id
        // is still selectable so the dropdown is never empty of real choices.
        label: device.label || device.deviceId,
      })),
    });
  }

  const onDeviceChange = () => { void publishMicOptions(); };
  navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
  void publishMicOptions();

  syncAction();

  return () => {
    disposed = true;
    clearChunkTimer();
    cancelTyping();
    unregister();
    action.unregister();
    micSetting?.unregister();
    navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    if (recording) {
      void recording.dispose();
      recording = null;
    }
    activeComposer = null;
  };
}
