/**
 * Chess widget — widget-first (mountOnAttach).
 *
 * 1. Setup screen: pick white or black
 * 2. "Start Game" calls setup op + activate()
 * 3. Board renders, oriented from user's perspective
 * 4. Polls when it's the agent's turn
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

function diffFen(oldFen: string, newFen: string): { from: string; to: string } | null {
  const oldMap = fenToSquareMap(oldFen);
  const newMap = fenToSquareMap(newFen);
  let from: string | null = null;
  let to: string | null = null;
  for (const sq of Object.keys(oldMap)) {
    const was = oldMap[sq];
    const is = newMap[sq];
    if (was && !is) from = sq;
    if (!was && is) to = sq;
    if (was && is && was !== is) to = sq;
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

function isUserPiece(piece: string, userColor: "w" | "b"): boolean {
  return userColor === "w" ? isWhite(piece) : !isWhite(piece);
}

// ── Styles ──

const boardColors = {
  light: "var(--bg-surface, #111)",
  dark: "var(--bg, #000)",
  selected: "rgba(80, 144, 255, 0.5)",
  lastMoveUser: "rgba(80, 144, 255, 0.2)",
  lastMoveAgent: "rgba(232, 155, 80, 0.25)",
};

const c = {
  bg: "var(--bg, #000)",
  surface: "var(--bg-surface, #111)",
  border: "var(--border, #2a2a2a)",
  text: "var(--text, #e0e0e0)",
  textDim: "var(--text-dim, #666)",
  textLabel: "var(--text-label, #aaa)",
  accent: "var(--accent, #5090ff)",
};

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    fontFamily: "var(--font-mono, monospace)",
    background: c.bg,
    gap: "8px",
    padding: "8px",
  },
  board: {
    display: "grid",
    gridTemplateColumns: "repeat(8, 1fr)",
    gridTemplateRows: "repeat(8, 1fr)",
    aspectRatio: "1",
    border: `1px solid ${c.border}`,
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
    color: c.textLabel,
    letterSpacing: "0.03em",
  },
  moveList: {
    flex: 1,
    overflow: "auto" as const,
    fontSize: "11px",
    padding: "4px 8px",
    color: c.textDim,
    lineHeight: "1.8",
  },
  error: {
    color: "var(--error, #ff3333)",
    fontSize: "12px",
    textAlign: "center" as const,
    padding: "4px",
  },
};

// ── Setup Screen ──

function SetupScreen({ onStart }: { onStart: (color: "w" | "b") => void }) {
  const [hover, setHover] = useState<"w" | "b" | null>(null);

  const btnBase = {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: "8px",
    padding: "24px",
    border: `1px solid ${c.border}`,
    borderRadius: "6px",
    background: c.surface,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "border-color 0.15s, background 0.15s",
    flex: 1,
  };

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      gap: "24px",
      padding: "24px",
      fontFamily: "var(--font-mono, monospace)",
      background: c.bg,
    }}>
      <div style={{
        fontSize: "11px",
        color: c.textLabel,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}>
        Choose your color
      </div>

      <div style={{ display: "flex", gap: "16px", width: "100%", maxWidth: "320px" }}>
        <button
          style={{
            ...btnBase,
            borderColor: hover === "w" ? c.accent : c.border,
            background: hover === "w" ? "rgba(80, 144, 255, 0.06)" : c.surface,
          }}
          onClick={() => onStart("w")}
          onMouseOver={() => setHover("w")}
          onMouseOut={() => setHover(null)}
        >
          <span style={{ fontSize: "40px", lineHeight: 1 }}>♔</span>
          <span style={{ fontSize: "12px", color: "#e8d5b5" }}>White</span>
          <span style={{ fontSize: "10px", color: c.textDim }}>You move first</span>
        </button>

        <button
          style={{
            ...btnBase,
            borderColor: hover === "b" ? c.accent : c.border,
            background: hover === "b" ? "rgba(80, 144, 255, 0.06)" : c.surface,
          }}
          onClick={() => onStart("b")}
          onMouseOver={() => setHover("b")}
          onMouseOut={() => setHover(null)}
        >
          <span style={{ fontSize: "40px", lineHeight: 1 }}>♚</span>
          <span style={{ fontSize: "12px", color: "#b58863" }}>Black</span>
          <span style={{ fontSize: "10px", color: c.textDim }}>Agent moves first</span>
        </button>
      </div>
    </div>
  );
}

// ── Board Component ──

function BoardView({
  callOp,
  userColor,
}: {
  callOp: MoveWidgetProps["callOp"];
  userColor: "w" | "b";
}) {
  const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const [fen, setFen] = useState(startFen);
  const [moves, setMoves] = useState<string[]>([]);
  const [gameStatus, setGameStatus] = useState<string>("active");
  const [selected, setSelected] = useState<{ file: number; rank: number } | null>(null);
  const [lastUserMove, setLastUserMove] = useState<{ from: string; to: string } | null>(null);
  const [lastAgentMove, setLastAgentMove] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevFenRef = useRef<string | null>(null);

  const agentColor = userColor === "w" ? "b" : "w";

  const refreshBoard = useCallback(async () => {
    const res = await callOp("board");
    if (!res.ok) return;
    const msg = res.message ?? "";

    const fenMatch = msg.match(/FEN:\s*(.+)/);
    if (fenMatch) {
      const newFen = fenMatch[1].trim();
      setFen(prev => {
        if (prevFenRef.current && turnFromFen(prevFenRef.current) === agentColor && turnFromFen(newFen) === userColor) {
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
  }, [callOp, agentColor, userColor]);

  useEffect(() => { refreshBoard(); }, [refreshBoard]);

  // Poll when it's the agent's turn
  useEffect(() => {
    const turn = turnFromFen(fen);
    if (turn === agentColor && gameStatus === "active") {
      setThinking(true);
      pollRef.current = setInterval(refreshBoard, 2000);
    } else {
      setThinking(false);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fen, gameStatus, refreshBoard, agentColor]);

  const handleClick = async (file: number, rank: number, piece: string | null) => {
    if (gameStatus !== "active") return;
    if (turnFromFen(fen) !== userColor) return;

    if (selected) {
      const from = squareName(selected.file, selected.rank);
      const to = squareName(file, rank);

      if (from === to) { setSelected(null); return; }
      if (piece && isUserPiece(piece, userColor)) { setSelected({ file, rank }); return; }

      setSelected(null);
      setError(null);

      const fromBoard = parseFen(fen);
      const fromRow = 7 - selected.rank;
      const movingPiece = fromBoard[fromRow]?.[selected.file]?.piece;
      // Auto-promote pawns: user white pawn reaching rank 8, user black pawn reaching rank 1
      const promotion = userColor === "w"
        ? (movingPiece?.toUpperCase() === "P" && rank === 7 ? "q" : undefined)
        : (movingPiece?.toLowerCase() === "p" && rank === 0 ? "q" : undefined);

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
      if (piece && isUserPiece(piece, userColor)) {
        setSelected({ file, rank });
        setError(null);
      }
    }
  };

  // Orient board from user's perspective
  const rawBoard = parseFen(fen);
  const board = userColor === "b" ? [...rawBoard].reverse().map(row => [...row].reverse()) : rawBoard;
  const turn = turnFromFen(fen);

  return (
    <div style={styles.container}>
      <div style={styles.status}>
        {gameStatus !== "active"
          ? gameStatus
          : thinking
            ? "Agent is thinking..."
            : turn === userColor
              ? `Your move (${userColor === "w" ? "White" : "Black"})`
              : "Waiting for agent..."}
      </div>

      <div style={styles.board}>
        {board.map((row, ri) =>
          row.map((sq, fi) => {
            // Visual position for coloring
            const visualRow = userColor === "b" ? (7 - ri) : ri;
            const visualCol = userColor === "b" ? (7 - fi) : fi;
            const light = (visualRow + visualCol) % 2 === 0;
            const isSelected = selected?.file === sq.file && selected?.rank === sq.rank;
            const sqName = squareName(sq.file, sq.rank);
            const isUserMoveSquare = lastUserMove && (lastUserMove.from === sqName || lastUserMove.to === sqName);
            const isAgentMoveSquare = lastAgentMove && (lastAgentMove.from === sqName || lastAgentMove.to === sqName);

            const bg = isSelected
              ? boardColors.selected
              : isUserMoveSquare
                ? boardColors.lastMoveUser
                : isAgentMoveSquare
                  ? boardColors.lastMoveAgent
                  : light ? boardColors.light : boardColors.dark;

            const pieceStyle = sq.piece
              ? isWhite(sq.piece)
                ? { color: "#e8d5b5", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }
                : { color: "#b58863", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }
              : {};

            return (
              <div
                key={`${sq.file}-${sq.rank}`}
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
                onClick={() => handleClick(sq.file, sq.rank, sq.piece)}
              >
                {sq.piece ? PIECE_CHARS[sq.piece] ?? "" : ""}
              </div>
            );
          })
        )}
      </div>

      {error && <div style={styles.error}>{error}</div>}

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

// ── Main Widget ──

export default function ChessWidget({ callOp, activate }: MoveWidgetProps) {
  const [userColor, setUserColor] = useState<"w" | "b" | null>(null);
  const [starting, setStarting] = useState(false);

  // Check if there's already a game in progress (resuming)
  useEffect(() => {
    callOp("board").then(res => {
      if (res.ok && res.message) {
        const colorMatch = res.message.match(/UserColor:\s*(w|b)/);
        if (colorMatch) {
          setUserColor(colorMatch[1] as "w" | "b");
        }
      }
    });
  }, [callOp]);

  const handleStart = async (color: "w" | "b") => {
    setStarting(true);
    await callOp("setup", { userColor: color });
    if (activate) {
      await activate();
    }
    setUserColor(color);
    setStarting(false);
  };

  if (starting) {
    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        fontFamily: "var(--font-mono, monospace)",
        background: c.bg,
        color: c.textLabel,
        fontSize: "12px",
      }}>
        Starting game...
      </div>
    );
  }

  if (!userColor) {
    return <SetupScreen onStart={handleStart} />;
  }

  return <BoardView callOp={callOp} userColor={userColor} />;
}
