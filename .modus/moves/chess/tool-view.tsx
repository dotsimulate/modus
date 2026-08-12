import { useEffect, useState } from "react";
import type { MoveToolViewProps } from "../../../harness/ui/src/move-tool-view";

const PIECES: Record<string, string> = {
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
};

type Square = { piece: string | null; file: number; rank: number };

function parseFen(fen: string): Square[][] {
  return fen.split(" ")[0]!.split("/").map((row, rowIndex) => {
    const squares: Square[] = [];
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        for (let i = 0; i < Number(char); i++) squares.push({ piece: null, file: file++, rank: 7 - rowIndex });
      } else {
        squares.push({ piece: char, file: file++, rank: 7 - rowIndex });
      }
    }
    return squares;
  });
}

function squareName(file: number, rank: number): string {
  return `${String.fromCharCode(97 + file)}${rank + 1}`;
}

export default function ChessToolView({
  result,
  status,
  isLatest,
  callOp,
  submitMessage,
}: MoveToolViewProps) {
  const snapshotFen = typeof result?.fen === "string" ? result.fen : "";
  const [fen, setFen] = useState(snapshotFen);
  const [selected, setSelected] = useState<Square | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setFen(snapshotFen), [snapshotFen]);

  if (!fen) {
    return <div style={{ padding: 10, color: "var(--text-dim)" }}>{result?.error as string ?? "Chess move unavailable"}</div>;
  }

  const userColor = result?.userColor === "b" ? "b" : "w";
  const gameStatus = typeof result?.gameStatus === "string" ? result.gameStatus : "active";
  const turn = fen.split(" ")[1] ?? "w";
  const playable = isLatest && status === "completed" && gameStatus === "active" && turn === userColor;
  const board = parseFen(fen);
  const oriented = userColor === "w" ? board : [...board].reverse().map((row) => [...row].reverse());

  const play = async (square: Square) => {
    if (!playable) return;
    if (!selected) {
      if (square.piece && (square.piece === square.piece.toUpperCase()) === (userColor === "w")) setSelected(square);
      return;
    }
    const from = squareName(selected.file, selected.rank);
    const to = squareName(square.file, square.rank);
    setSelected(null);
    setError(null);
    const response = await callOp("move", { from, to, promotion: "q" });
    if (!response.ok) {
      setError(response.error ?? "Illegal move");
      return;
    }
    if (typeof response.fen === "string") setFen(response.fen);
    await submitMessage(`I played ${from}-${to}. Make your chess move using the attached chess API.`);
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", maxWidth: 390 }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 9px", background: "var(--bg-surface)" }}>
        <strong>Chess</strong>
        <span style={{ color: playable ? "var(--success)" : "var(--text-dim)", fontSize: 12 }}>
          {playable ? "your move" : isLatest ? (gameStatus === "active" ? "agent turn" : gameStatus) : "history"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(28px, 1fr))", aspectRatio: "1" }}>
        {oriented.flat().map((square) => {
          const active = selected?.file === square.file && selected.rank === square.rank;
          const dark = (square.file + square.rank) % 2 === 0;
          return (
            <button
              key={squareName(square.file, square.rank)}
              type="button"
              disabled={!playable}
              onClick={() => void play(square)}
              title={squareName(square.file, square.rank)}
              style={{
                border: 0,
                padding: 0,
                cursor: playable ? "pointer" : "default",
                background: active ? "var(--accent)" : dark ? "#8a8174" : "#d8d1c5",
                color: square.piece === square.piece?.toUpperCase() ? "#f8f8f8" : "#171717",
                fontSize: "clamp(20px, 5vw, 36px)",
                textShadow: "0 1px 2px #0008",
              }}
            >
              {square.piece ? PIECES[square.piece] : ""}
            </button>
          );
        })}
      </div>
      {error && <div style={{ padding: 7, color: "var(--error)", fontSize: 12 }}>{error}</div>}
    </div>
  );
}
