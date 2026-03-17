/**
 * Chess move — API contract move.
 *
 * Declares handlers for chess ops. State managed via ctx.state API.
 * User plays White (via UI widget). Agent plays Black (via modus_submit).
 * Game state persists to disk — games are resumable across sessions.
 */

import { Chess } from "chess.js";
import type { MoveContext, MoveApiContext, MoveApiHandler } from "../../../harness/move-types";

// ── State shape ──

interface ChessState {
  fen: string;
  moves: string[];
  status: "active" | "checkmate" | "stalemate" | "draw" | "resigned";
}

function newGameState(): ChessState {
  return {
    fen: new Chess().fen(),
    moves: [],
    status: "active",
  };
}

function loadGame(state: ChessState | undefined): { chess: Chess; state: ChessState } {
  const s = state ?? newGameState();
  const chess = new Chess(s.fen);
  return { chess, state: s };
}

function gameOverReason(chess: Chess): string {
  if (chess.isCheckmate()) return chess.turn() === "w" ? "Checkmate — Black wins!" : "Checkmate — White wins.";
  if (chess.isStalemate()) return "Stalemate — draw.";
  if (chess.isThreefoldRepetition()) return "Draw by repetition.";
  if (chess.isInsufficientMaterial()) return "Draw — insufficient material.";
  if (chess.isDraw()) return "Draw.";
  return "Game over.";
}

function statusFromChess(chess: Chess): ChessState["status"] {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isDraw()) return "draw";
  return "active";
}

// ── gather() ──

export async function gather(ctx: MoveContext): Promise<string> {
  return `You are playing chess as Black. The user plays White through the UI.

Game token: \`${ctx.apiToken}\`
Game ID: \`${ctx.instanceId}\`

## API (use modus_submit with the game token above)

**Make a move:**
\`{ "op": "move", "move": "e5" }\`

**View board** (if you lose track):
\`{ "op": "board" }\`

**Resign:**
\`{ "op": "resign" }\`

## Rules
- Standard chess. You are Black.
- Wait for the user's move before playing yours. You'll be notified when they move.
- Illegal moves return an error. No hints. Figure it out.
- Play to win.`;
}

// ── Handlers ──

export const handlers: Record<string, MoveApiHandler> = {
  move: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const raw = await ctx.state.get<ChessState>();
    const { chess, state } = loadGame(raw);

    if (state.status !== "active") {
      return { ok: false, error: gameOverReason(chess) };
    }

    // Accept either SAN string { move: "Nf3" } or coordinate pair { from: "g1", to: "f3" }
    const moveStr = data.move;
    const from = data.from;
    const to = data.to;
    const promotion = typeof data.promotion === "string" ? data.promotion : undefined;

    if (typeof moveStr !== "string" && (typeof from !== "string" || typeof to !== "string")) {
      return { ok: false, error: "Provide 'move' (SAN) or 'from'+'to' (coordinates)" };
    }

    // Validate turn — user is White, agent is Black
    const expectedTurn = ctx.caller === "user" ? "w" : "b";
    if (chess.turn() !== expectedTurn) {
      return { ok: false, error: "Not your turn" };
    }

    // Normalize SAN: piece letters must be uppercase (N, B, R, Q, K)
    const normalizedMove = typeof moveStr === "string"
      ? moveStr.replace(/^([nbrqk])(?=[a-h1-8x])/i, (c) => c.toUpperCase())
      : moveStr;

    let result;
    try {
      if (typeof normalizedMove === "string") {
        result = chess.move(normalizedMove);
      } else {
        result = chess.move({ from: from as string, to: to as string, promotion });
      }
    } catch {
      const desc = typeof normalizedMove === "string" ? normalizedMove : `${from}-${to}`;
      return { ok: false, error: `Illegal move: ${desc}` };
    }

    state.fen = chess.fen();
    state.moves.push(result.san);
    state.status = statusFromChess(chess);
    await ctx.state.set(state);

    // If game ended with this move
    if (state.status !== "active") {
      const reason = gameOverReason(chess);
      if (ctx.caller === "user") ctx.notify(`User played ${result.san}. ${reason}`);
      return { ok: true, message: reason };
    }

    // Notify the other side
    if (ctx.caller === "user") {
      ctx.notify(`User played ${result.san}. Your turn.`);
      return { ok: true, message: "Move accepted" };
    }

    // Agent played — user sees it through widget polling/state
    return { ok: true, message: "Move accepted" };
  },

  board: async (ctx: MoveApiContext) => {
    const raw = await ctx.state.get<ChessState>();
    const { chess, state } = loadGame(raw);
    const lines: string[] = [
      chess.ascii(),
      `FEN: ${state.fen}`,
      `Turn: ${chess.turn() === "w" ? "White (user)" : "Black (you)"}`,
      `Moves: ${state.moves.join(" ")}`,
    ];
    if (chess.isCheck()) lines.push("CHECK");
    if (state.status !== "active") lines.push(gameOverReason(chess));
    return { ok: true, message: lines.join("\n") };
  },

  resign: async (ctx: MoveApiContext) => {
    const raw = await ctx.state.get<ChessState>();
    const { state } = loadGame(raw);
    state.status = "resigned";
    await ctx.state.set(state);
    const who = ctx.caller === "user" ? "User" : "Agent";
    const msg = `${who} resigned.`;
    if (ctx.caller === "agent") ctx.notify(msg);
    return { ok: true, message: msg };
  },
};
