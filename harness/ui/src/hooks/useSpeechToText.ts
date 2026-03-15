/**
 * useSpeechToText — dual-mode speech recognition hook.
 *
 * Mode 1: Web Speech API (SpeechRecognition) — live streaming, zero setup.
 * Mode 2: Whisper backend — records audio blob, posts to /api/whisper/transcribe.
 *
 * Returns a unified interface regardless of mode.
 */

import { useState, useCallback, useRef } from "react";
import { transcribeAudio } from "../api";

type SpeechMode = "webspeech" | "whisper";

type SpeechToTextState = {
  transcript: string;
  listening: boolean;
  error: string | null;
  mode: SpeechMode;
  supported: boolean;
  start: () => void;
  stop: () => void;
  clear: () => void;
};

const WEB_SPEECH_SUPPORTED =
  typeof window !== "undefined" &&
  ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

export function useSpeechToText(
  preferredMode: SpeechMode = "whisper",
  onTranscript?: (text: string) => void,
): SpeechToTextState {
  const [transcript, setTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const mode = preferredMode === "webspeech" && WEB_SPEECH_SUPPORTED ? "webspeech" : "whisper";
  const supported = mode === "webspeech" ? WEB_SPEECH_SUPPORTED : true;

  const startWebSpeech = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setError("Web Speech API not supported"); return; }
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
      let final = "";
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        }
      }
      if (final) {
        setTranscript((prev) => {
          const next = prev ? `${prev} ${final}` : final;
          onTranscript?.(next);
          return next;
        });
      }
    };

    recognition.onerror = (event: any) => {
      setError(event.error);
      setListening(false);
    };

    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
    setError(null);
  }, [onTranscript]);

  const stopWebSpeech = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const startWhisper = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size < 100) return; // too short, skip

        try {
          const file = new File([blob], "recording.webm", { type: "audio/webm" });
          const text = await transcribeAudio(file);
          if (text) {
            setTranscript((prev) => {
              const next = prev ? `${prev} ${text}` : text;
              onTranscript?.(next);
              return next;
            });
          }
        } catch (err: any) {
          setError(err.message || "Transcription failed");
        }
      };

      recorderRef.current = recorder;
      recorder.start();
      setListening(true);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Microphone access denied");
    }
  }, [onTranscript]);

  const stopWhisper = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setListening(false);
  }, []);

  const start = mode === "webspeech" ? startWebSpeech : startWhisper;
  const stop = mode === "webspeech" ? stopWebSpeech : stopWhisper;

  const clear = useCallback(() => {
    setTranscript("");
    setError(null);
  }, []);

  return { transcript, listening, error, mode, supported, start, stop, clear };
}
