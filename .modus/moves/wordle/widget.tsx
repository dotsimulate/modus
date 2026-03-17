/**
 * Wordle widget — renders the 6×5 guess grid in the right panel.
 *
 * User watches the agent's guesses accumulate in real time.
 * User can also set a custom word (or randomize) before the game starts.
 * Polls state while game is active.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { MoveWidgetProps } from "../../../../harness/ui/src/components/MoveWidget";
import type { WordleState, LetterResult } from "./context";

const MAX_GUESSES = 6;
const WORD_LEN = 5;

// ── Color tokens ──

const colors = {
  correct: "var(--success, #3a7d44)",
  present: "var(--warning, #b59f3b)",
  absent: "var(--bg-raised, #1e1e1e)",
  empty: "var(--bg-surface, #111)",
  border: "var(--border, #2a2a2a)",
  borderActive: "var(--border-focus, #444)",
  text: "var(--text, #e0e0e0)",
  textDim: "var(--text-dim, #666)",
  textLabel: "var(--text-label, #aaa)",
  bg: "var(--bg, #000)",
  error: "var(--error, #ff4444)",
  inputBg: "var(--bg-surface, #111)",
};

// ── Styles ──

const s = {
  root: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    height: "100%",
    padding: "16px 8px",
    gap: "12px",
    background: colors.bg,
    fontFamily: "var(--font-mono, monospace)",
    overflowY: "auto" as const,
  },
  grid: {
    display: "grid",
    gridTemplateRows: `repeat(${MAX_GUESSES}, 1fr)`,
    gap: "4px",
    width: "min(240px, 100%)",
  },
  row: {
    display: "grid",
    gridTemplateColumns: `repeat(${WORD_LEN}, 1fr)`,
    gap: "4px",
  },
  cell: (state: "empty" | LetterResult) => ({
    aspectRatio: "1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "clamp(14px, 4cqw, 22px)",
    fontWeight: 700,
    letterSpacing: "0.05em",
    border: `1px solid ${state === "empty" ? colors.border : "transparent"}`,
    borderRadius: "3px",
    background: state === "empty"
      ? colors.empty
      : state === "correct"
        ? colors.correct
        : state === "present"
          ? colors.present
          : colors.absent,
    color: state === "empty" ? colors.textDim : colors.text,
    transition: "background 0.15s",
    containerType: "inline-size" as const,
  }),
  status: {
    fontSize: "12px",
    color: colors.textLabel,
    letterSpacing: "0.04em",
    textAlign: "center" as const,
  },
  controls: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
    width: "min(240px, 100%)",
  },
  label: {
    fontSize: "10px",
    color: colors.textDim,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
  },
  inputRow: {
    display: "flex",
    gap: "4px",
  },
  input: {
    flex: 1,
    background: colors.inputBg,
    border: `1px solid ${colors.border}`,
    borderRadius: "3px",
    color: colors.text,
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "13px",
    padding: "5px 8px",
    outline: "none",
    textTransform: "uppercase" as const,
  },
  btn: {
    background: "transparent",
    border: `1px solid ${colors.border}`,
    borderRadius: "3px",
    color: colors.textLabel,
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "11px",
    padding: "5px 10px",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  errorMsg: {
    fontSize: "11px",
    color: colors.error,
    textAlign: "center" as const,
  },
};

// ── Component ──

export default function WordleWidget({ callOp }: MoveWidgetProps) {
  const [game, setGame] = useState<WordleState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customWord, setCustomWord] = useState("");
  const [settingWord, setSettingWord] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const res = await callOp("status");
    if (!res.ok || !res.message) return;
    try {
      const data = JSON.parse(res.message);
      setGame(data as WordleState);
    } catch {
      // ignore parse errors
    }
  }, [callOp]);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll while active
  useEffect(() => {
    if (game?.status === "active") {
      pollRef.current = setInterval(refresh, 2000);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [game?.status, refresh]);

  const setWord = async () => {
    const word = customWord.trim().toUpperCase();
    if (word.length !== 5 || !/^[A-Z]+$/.test(word)) {
      setError("Must be exactly 5 letters.");
      return;
    }
    const res = await callOp("new", { word });
    if (!res.ok) { setError(res.error ?? "Failed"); return; }
    setCustomWord("");
    setSettingWord(false);
    setError(null);
    refresh();
  };

  const newRandom = async () => {
    const res = await callOp("new", {});
    if (!res.ok) { setError(res.error ?? "Failed"); return; }
    setError(null);
    refresh();
  };

  // ── Render grid rows ──
  const rows: Array<{ letters: string[]; results: LetterResult[] | null }> = [];
  for (let i = 0; i < MAX_GUESSES; i++) {
    if (game && i < game.guesses.length) {
      rows.push({ letters: game.guesses[i].split(""), results: game.results[i] });
    } else {
      rows.push({ letters: [], results: null });
    }
  }

  const statusText = () => {
    if (!game) return "Loading...";
    if (game.status === "won") return `✅ Solved in ${game.guesses.length}`;
    if (game.status === "lost") return `❌ Game over`;
    const left = MAX_GUESSES - game.guesses.length;
    return `${left} guess${left === 1 ? "" : "es"} remaining — waiting for agent`;
  };

  return (
    <div style={s.root}>
      <div style={s.status}>{statusText()}</div>

      <div style={s.grid}>
        {rows.map((row, ri) => (
          <div key={ri} style={s.row}>
            {Array.from({ length: WORD_LEN }, (_, ci) => {
              const letter = row.letters[ci] ?? "";
              const result: LetterResult | "empty" = row.results ? row.results[ci] : "empty";
              return (
                <div key={ci} style={s.cell(result)}>
                  {letter}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {error && <div style={s.errorMsg}>{error}</div>}

      {/* Controls — set word or randomize */}
      <div style={s.controls}>
        {settingWord ? (
          <>
            <span style={s.label}>Set word</span>
            <div style={s.inputRow}>
              <input
                style={s.input}
                value={customWord}
                maxLength={5}
                placeholder="CRANE"
                onChange={e => setCustomWord(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === "Enter" && setWord()}
                autoFocus
              />
              <button style={s.btn} onClick={setWord}>Set</button>
              <button style={s.btn} onClick={() => { setSettingWord(false); setError(null); }}>✕</button>
            </div>
          </>
        ) : (
          <div style={s.inputRow}>
            <button style={s.btn} onClick={newRandom}>New game</button>
            <button style={s.btn} onClick={() => setSettingWord(true)}>Set word</button>
          </div>
        )}
      </div>
    </div>
  );
}
