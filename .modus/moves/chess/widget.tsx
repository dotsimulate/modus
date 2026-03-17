/**
 * Chess widget — renders an interactive board in the RightPanel.
 *
 * User plays White by clicking pieces and target squares.
 * Sends { from, to } coordinates — the backend handles SAN conversion.
 * Polls board state when it's the agent's turn.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { MoveWidgetProps } from "../../../../harness/ui/src/components/MoveWidget";

// ── Piece rendering ──

const PIECE_CHARS: Record<string, string> = {
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
  k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙",
};

type Square = { piece: string | null; file: number; rank: number };

function parseFen(fen: string): Square[][] {
  const rows = fen.split(" ")[0].split("/");
  const board: Square[][] = [];
  for (let r = 0; r < 8; r++) {
    const row: Square[] = [];
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= "1" && ch <= "8") {
        for (let i = 0; i < parseInt(ch); i++) {
          row.push({ piece: null, file, rank: 7 - r });
          file++;
        }
      } else {
        row.push({ piece: ch, file, rank: 7 - r });
        file++;
      }
    }
    board.push(row);
  }
  return board;
}

function fenToSquareMap(fen: string): Record<string, string | null> {
  const board = parseFen(fen);
  const map: Record<string, string | null> = {};
  for (const row of board) {
    for (const sq of row) {
      map[squareName(sq.file, sq.rank)] = sq.piece;
    }
  }
  return map;
}

/** Find which squares changed between two FENs — returns { from, to } of the moved piece. */
function diffFen(oldFen: string, newFen: string): { from: string; to: string } | null {
  const oldMap = fenToSquareMap(oldFen);
  const newMap = fenToSquareMap(newFen);
  let from: string | null = null;
  let to: string | null = null;
  for (const sq of Object.keys(oldMap)) {
    const was = oldMap[sq];
    const is = newMap[sq];
    if (was && !is) from = sq;           // piece left this square
    if (!was && is) to = sq;             // piece arrived on this square
    if (was && is && was !== is) to = sq; // capture: different piece arrived
  }
  if (from && to) return { from, to };
  return null;
}

function turnFromFen(fen: string): "w" | "b" {
  return (fen.split(" ")[1] ?? "w") as "w" | "b";
}

function squareName(file: number, rank: number): string {
  return String.fromCharCode(97 + file) + (rank + 1);
}

function isWhite(piece: string): boolean {
  return piece === piece.toUpperCase();
}

// ── Styles — uses CSS vars from the host app's theme ──

const boardColors = {
  light: "var(--bg-surface, #111)",   // --bg-surface
  dark: "var(--bg, #000)",            // --bg
  selected: "rgba(80, 144, 255, 0.5)",
  lastMoveUser: "rgba(80, 144, 255, 0.2)",
  lastMoveAgent: "rgba(232, 155, 80, 0.25)",
};

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    fontFamily: "var(--font-mono, monospace)",
    background: "var(--bg, #000)",
    gap: "8px",
    padding: "8px",
  },
  board: {
    display: "grid",
    gridTemplateColumns: "repeat(8, 1fr)",
    gridTemplateRows: "repeat(8, 1fr)",
    aspectRatio: "1",
    border: "1px solid var(--border, #1e1e1e)",
    borderRadius: "4px",
    overflow: "hidden",
    maxWidth: "480px",
    alignSelf: "center" as const,
    width: "100%",
    containerType: "inline-size" as const,
  },
  status: {
    textAlign: "center" as const,
    padding: "6px",
    fontSize: "12px",
    color: "var(--text-label, #aaa)",
    letterSpacing: "0.03em",
  },
  moveList: {
    flex: 1,
    overflow: "auto" as const,
    fontSize: "11px",
    padding: "4px 8px",
    color: "var(--text-dim, #666)",
    lineHeight: "1.8",
  },
  error: {
    color: "var(--error, #ff3333)",
    fontSize: "12px",
    textAlign: "center" as const,
    padding: "4px",
  },
};

// ── Component ──

export default function ChessWidget({ callOp }: MoveWidgetProps) {
  const [fen, setFen] = useState("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  const [moves, setMoves] = useState<string[]>([]);
  const [gameStatus, setGameStatus] = useState<string>("active");
  const [selected, setSelected] = useState<{ file: number; rank: number } | null>(null);
  const [lastUserMove, setLastUserMove] = useState<{ from: string; to: string } | null>(null);
  const [lastAgentMove, setLastAgentMove] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevFenRef = useRef<string | null>(null);

  // ── Fetch board state ──
  const refreshBoard = useCallback(async () => {
    const res = await callOp("board");
    if (!res.ok) return;
    const msg = res.message ?? "";

    const fenMatch = msg.match(/FEN:\s*(.+)/);
    if (fenMatch) {
      const newFen = fenMatch[1].trim();
      setFen(prev => {
        // Detect agent move: if it was black's turn and now it's white's, diff the boards
        if (prevFenRef.current && turnFromFen(prevFenRef.current) === "b" && turnFromFen(newFen) === "w") {
          const diff = diffFen(prevFenRef.current, newFen);
          if (diff) setLastAgentMove(diff);
        }
        prevFenRef.current = newFen;
        return newFen;
      });
    }

    const movesMatch = msg.match(/Moves:\s*(.+)/);
    if (movesMatch) {
      const parsed = movesMatch[1].trim().split(/\s+/).filter(Boolean);
      setMoves(parsed);
    } else if (msg.includes("Moves:")) {
      setMoves([]);
    }

    if (msg.includes("Checkmate") || msg.includes("Stalemate") || msg.includes("Draw") || msg.includes("resigned")) {
      const statusLine = msg.split("\n").find(l =>
        l.includes("Checkmate") || l.includes("Stalemate") || l.includes("Draw") || l.includes("resigned")
      );
      setGameStatus(statusLine ?? "Game over");
    }
  }, [callOp]);

  // Initial load
  useEffect(() => { refreshBoard(); }, [refreshBoard]);

  // Poll when it's the agent's turn
  useEffect(() => {
    const turn = turnFromFen(fen);
    if (turn === "b" && gameStatus === "active") {
      setThinking(true);
      pollRef.current = setInterval(refreshBoard, 2000);
    } else {
      setThinking(false);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fen, gameStatus, refreshBoard]);

  // ── Handle square click ──
  const handleClick = async (file: number, rank: number, piece: string | null) => {
    if (gameStatus !== "active") return;
    if (turnFromFen(fen) !== "w") return;

    if (selected) {
      const from = squareName(selected.file, selected.rank);
      const to = squareName(file, rank);

      if (from === to) { setSelected(null); return; }
      if (piece && isWhite(piece)) { setSelected({ file, rank }); return; }

      setSelected(null);
      setError(null);

      const fromBoard = parseFen(fen);
      const fromRow = 7 - selected.rank;
      const movingPiece = fromBoard[fromRow]?.[selected.file]?.piece;
      const promotion = movingPiece?.toUpperCase() === "P" && rank === 7 ? "q" : undefined;

      const res = await callOp("move", { from, to, promotion });
      if (!res.ok) {
        setError(res.error ?? "Move failed");
        return;
      }
      setLastUserMove({ from, to });
      setLastAgentMove(null);
      setError(null);
      await refreshBoard();
    } else {
      if (piece && isWhite(piece)) {
        setSelected({ file, rank });
        setError(null);
      }
    }
  };

  // ── Render ──
  const board = parseFen(fen);
  const turn = turnFromFen(fen);

  return (
    <div style={styles.container}>
      {/* Status bar */}
      <div style={styles.status}>
        {gameStatus !== "active"
          ? gameStatus
          : thinking
            ? "Agent is thinking..."
            : turn === "w"
              ? "Your move (White)"
              : "Waiting for agent..."}
      </div>

      {/* Board */}
      <div style={styles.board}>
        {board.map((row, ri) =>
          row.map((sq, fi) => {
            const light = (ri + fi) % 2 === 0;
            const isSelected = selected?.file === fi && selected?.rank === sq.rank;
            const sqName = squareName(fi, sq.rank);
            const isUserMove = lastUserMove && (lastUserMove.from === sqName || lastUserMove.to === sqName);
            const isAgentMove = lastAgentMove && (lastAgentMove.from === sqName || lastAgentMove.to === sqName);

            const bg = isSelected
              ? boardColors.selected
              : isUserMove
                ? boardColors.lastMoveUser
                : isAgentMove
                  ? boardColors.lastMoveAgent
                  : light ? boardColors.light : boardColors.dark;

            const pieceStyle = sq.piece
              ? isWhite(sq.piece)
                ? { color: "#e8d5b5", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }
                : { color: "#b58863", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }
              : {};

            return (
              <div
                key={`${ri}-${fi}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "10cqi",
                  lineHeight: 1,
                  cursor: "pointer",
                  userSelect: "none",
                  backgroundColor: bg,
                  transition: "background-color 0.1s",
                  ...pieceStyle,
                }}
                onClick={() => handleClick(fi, sq.rank, sq.piece)}
              >
                {sq.piece ? PIECE_CHARS[sq.piece] ?? "" : ""}
              </div>
            );
          })
        )}
      </div>

      {/* Error */}
      {error && <div style={styles.error}>{error}</div>}

      {/* Move list */}
      <div style={styles.moveList}>
        {moves.length === 0
          ? "No moves yet"
          : moves.map((m, i) => (
              <span key={i}>
                {i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ""}
                {m}{" "}
              </span>
            ))}
      </div>
    </div>
  );
}
