import { useState, useEffect, useRef } from "react";

/** Extract words from feed text, deduped and shuffled. */
function extractWords(feed?: string): string[] {
  if (!feed) return [];
  // Split on whitespace/punctuation, keep fragments 2-12 chars
  const raw = feed.match(/[a-zA-Z0-9_$./#@:>={}\[\]-]{2,12}/g);
  if (!raw) return [];
  // Dedupe, keep last ~60 unique words
  const seen = new Set<string>();
  const words: string[] = [];
  for (let i = raw.length - 1; i >= 0 && words.length < 60; i--) {
    const w = raw[i];
    if (!seen.has(w)) { seen.add(w); words.push(w); }
  }
  return words;
}

/** Build a noise string from feed words, roughly filling `targetLen` chars. */
function buildWordNoise(targetLen: number, words: string[]): string {
  if (!words.length) return "·".repeat(targetLen);
  let out = "";
  let safety = 100;
  while (out.length < targetLen && --safety > 0) {
    const w = words[Math.floor(Math.random() * words.length)];
    if (out.length > 0) out += " ";
    out += w;
  }
  return out.slice(0, targetLen);
}

type Props = {
  feed?: string;
  resolveText?: string;
  onResolved?: () => void;
};

const SCRAMBLE_LEN = 50;

/** Scrambling word noise fed by stream content, resolves into tagline text. */
export function StreamingCursor({ feed, resolveText, onResolved }: Props) {
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const [noise, setNoise] = useState("");
  const [phase, setPhase] = useState<"scramble" | "resolve">("scramble");
  const [revealed, setRevealed] = useState(0);
  const targetLen = resolveText ? resolveText.length : SCRAMBLE_LEN;

  // Scramble — cycle word noise
  useEffect(() => {
    if (phase !== "scramble") return;
    const tick = () => {
      const words = extractWords(feedRef.current);
      setNoise(buildWordNoise(SCRAMBLE_LEN, words));
    };
    tick();
    const id = setInterval(tick, 280);
    return () => clearInterval(id);
  }, [phase]);

  // Transition to resolve
  useEffect(() => {
    if (resolveText && phase === "scramble") {
      setPhase("resolve");
      setRevealed(0);
    }
  }, [resolveText, phase]);

  // Resolve — reveal left to right
  useEffect(() => {
    if (phase !== "resolve" || !resolveText) return;
    if (revealed >= targetLen) {
      onResolved?.();
      return;
    }
    const id = setInterval(() => {
      setRevealed((r) => Math.min(r + 2, targetLen));
      const words = extractWords(feedRef.current);
      setNoise(buildWordNoise(targetLen, words));
    }, 25);
    return () => clearInterval(id);
  }, [phase, revealed, resolveText, targetLen, onResolved]);

  const display = phase === "resolve" && resolveText
    ? resolveText.slice(0, revealed) + noise.slice(revealed)
    : noise;

  return (
    <span className="sc-noise">
      {phase === "resolve" && resolveText ? (
        <>
          <span className="sc-resolved">{display.slice(0, revealed)}</span>
          <span className="sc-glyphs">{display.slice(revealed)}</span>
        </>
      ) : (
        <span className="sc-glyphs">{display}</span>
      )}
    </span>
  );
}
