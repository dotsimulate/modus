console.log("[Whisper] Loading extension... version 2.5");
const SHORTCUT = "Ctrl+Shift+~";
const BUFFER_SIZE = 4096;
const RMS_THRESHOLD = 0.015;
const SILENCE_MS = 1000;
const MIN_CHUNK_MS = 2000;
const MAX_CHUNK_MS = 30000;
const PRE_ROLL_MS = 250;
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

async function createRecordingSession() {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
    throw new Error("browser audio capture is not available");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
  const preRollLimit = Math.max(1, Math.round((context.sampleRate * PRE_ROLL_MS) / 1000));
  let preRollChunks = [];
  let preRollLength = 0;
  let chunkChunks = [];
  let chunkLength = 0;
  let chunkHasSpeech = false;
  let silenceMs = 0;
  let closed = false;

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
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);

    const level = calculateLevel(copy);
    const isSpeech = level >= RMS_THRESHOLD;
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
  let recording = null;
  let pendingUploads = 0;
  let disposed = false;
  let uploadChain = Promise.resolve();
  let chunkTimer = null;
  let typingTimer = null;
  let intendedDraft = null;
  let isGated = false;
  let lastAddedChunks = [];
  let clearedBuffer = "";

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
    let label = null;
    let tone = null;

    if (finishing) {
      label = "finishing";
      tone = "busy";
    } else if (recording) {
      if (isGated) {
        label = `say "start listening to me"`;
        tone = "gated";
      } else {
        label = "recording";
        tone = "active";
      }
    }

    action.update({
      title: finishing
        ? "Finishing voice transcription"
        : recording
          ? isGated ? "Transcription paused (say start listening to me)" : "Stop voice recording"
          : "Start voice transcription",
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

    const response = await api.request("/api/whisper/transcribe", {
      method: "POST",
      body,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.details || payload?.error || "transcription failed");
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
        console.error("[whisper-transcribe] transcription failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        pendingUploads = Math.max(0, pendingUploads - 1);
        syncAction();
      });

    return task;
  }

  function flushReadyChunk() {
    if (!recording || disposed) return;
    const blob = recording.takeReadyChunk();
    if (!blob || blob.size === 0) return;
    queueTranscription(blob, null);
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
          queueTranscription(wavBlob, null);
        }
      } catch (error) {
        console.error("[whisper-transcribe] recording failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await uploadChain;
        isGated = false;
        syncAction();
      }
      return;
    }

    if (!composer) return;

    try {
      recording = await createRecordingSession();
      chunkTimer = setInterval(flushReadyChunk, 250);
      isGated = false;
      syncAction();
    } catch (error) {
      console.error("[whisper-transcribe] recording failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      recording = null;
      syncAction();
    }
  }

  const unregister = api.registerShortcut(SHORTCUT, async ({ getComposer }) => {
    await toggleRecording(getComposer());
  });

  syncAction();

  return () => {
    disposed = true;
    clearChunkTimer();
    cancelTyping();
    unregister();
    action.unregister();
    if (recording) {
      void recording.dispose();
      recording = null;
    }
  };
}
