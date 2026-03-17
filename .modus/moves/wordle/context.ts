/**
 * Wordle move — API contract move.
 *
 * Proves information asymmetry: the answer lives in state and is never
 * returned to the agent. The agent receives only colored result patterns.
 *
 * User sets or randomizes the word via the widget.
 * Agent guesses via modus_submit. Up to 6 attempts.
 */

import type { MoveContext, MoveApiContext, MoveApiHandler } from "../../../harness/move-types";

// ── Word list ──

const WORDS = [
  "crane", "stare", "audio", "arise", "outer", "raise", "irate", "snare",
  "slate", "crate", "trace", "place", "grace", "space", "phase", "shade",
  "blade", "flame", "blame", "plane", "plate", "plank", "blank", "brand",
  "grant", "plant", "slant", "chant", "glare", "flare", "spare", "share",
  "shore", "store", "score", "smoke", "spoke", "stoke", "stone", "stove",
  "solve", "salve", "valve", "value", "table", "cable", "fable", "sable",
  "maple", "apple", "ample", "angle", "ankle", "alone", "phone", "prone",
  "groan", "moans", "loans", "ponds", "bonds", "fonds", "funds", "dunce",
  "dance", "lance", "prance", "trance", "fancy", "pansy", "tansy", "daisy",
  "rainy", "gravy", "savor", "favor", "labor", "vapor", "major", "minor",
  "tiger", "cider", "rider", "elder", "under", "other", "utter", "liter",
  "miter", "meter", "peter", "fever", "liver", "giver", "river", "cover",
  "lover", "hover", "novel", "level", "jewel", "towel", "vowel", "bowel",
  "repel", "expel", "excel", "pixel", "vixen", "ixen", "widen", "risen",
  "given", "liven", "often", "raven", "haven", "coven", "woven", "proven",
].filter(w => w.length === 5);

function randomWord(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

// ── State shape ──

export interface WordleState {
  answer: string;           // NEVER returned to agent
  guesses: string[];        // words guessed so far (uppercase)
  results: LetterResult[][]; // per-guess result arrays
  status: "active" | "won" | "lost";
}

export type LetterResult = "correct" | "present" | "absent";

const MAX_GUESSES = 6;

function newGame(answer?: string): WordleState {
  return {
    answer: (answer ?? randomWord()).toUpperCase(),
    guesses: [],
    results: [],
    status: "active",
  };
}

/** Score a guess against the answer. Returns one LetterResult per letter. */
function scoreGuess(guess: string, answer: string): LetterResult[] {
  const result: LetterResult[] = Array(5).fill("absent");
  const answerChars = answer.split("");
  const remaining: (string | null)[] = [...answerChars];

  // First pass: correct positions
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) {
      result[i] = "correct";
      remaining[i] = null;
    }
  }

  // Second pass: present but wrong position
  for (let i = 0; i < 5; i++) {
    if (result[i] === "correct") continue;
    const idx = remaining.indexOf(guess[i]);
    if (idx !== -1) {
      result[i] = "present";
      remaining[idx] = null;
    }
  }

  return result;
}

/** Convert a result array to emoji tiles for agent feedback. */
function toEmoji(results: LetterResult[]): string {
  return results.map(r => r === "correct" ? "🟩" : r === "present" ? "🟨" : "⬛").join("");
}

/** Format the full board as text (no answer revealed). */
function boardText(state: WordleState): string {
  const lines: string[] = [`Wordle — ${state.guesses.length}/${MAX_GUESSES} guesses`];
  for (let i = 0; i < state.guesses.length; i++) {
    lines.push(`${state.guesses[i]}  ${toEmoji(state.results[i])}`);
  }
  if (state.status === "won") lines.push(`✅ Solved in ${state.guesses.length}!`);
  if (state.status === "lost") lines.push(`❌ Game over. (${MAX_GUESSES} guesses used)`);
  return lines.join("\n");
}

// ── gather() ──

export async function gather(ctx: MoveContext): Promise<string> {
  return `You are playing Wordle. Guess the 5-letter word in ${MAX_GUESSES} tries.

Game token: \`${ctx.apiToken}\`

## API (use modus_submit with the token above)

**Guess a word:**
\`{ "op": "guess", "word": "crane" }\`

**Check your board:**
\`{ "op": "status" }\`

## Rules
- Exactly 5 letters, no proper nouns needed — any 5-letter guess accepted
- Each guess returns one result per letter:
  - 🟩 correct letter, correct position
  - 🟨 correct letter, wrong position
  - ⬛ letter not in word
- You have ${MAX_GUESSES} guesses total
- The answer is held by the harness. You will never be told it directly — figure it out from the patterns.
- Start with a strong opener (crane, stare, audio). Use the patterns to narrow down.`;
}

// ── Handlers ──

export const handlers: Record<string, MoveApiHandler> = {
  guess: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const state = await ctx.state.get<WordleState>();
    const game = state ?? newGame();

    if (game.status !== "active") {
      return { ok: false, error: game.status === "won" ? "Game already won." : "Game over — start a new game." };
    }

    const word = typeof data.word === "string" ? data.word.trim().toUpperCase() : null;
    if (!word || word.length !== 5 || !/^[A-Z]+$/.test(word)) {
      return { ok: false, error: "Word must be exactly 5 letters, alphabetic only." };
    }

    const result = scoreGuess(word, game.answer);
    game.guesses.push(word);
    game.results.push(result);

    if (word === game.answer) {
      game.status = "won";
      await ctx.state.set(game);
      ctx.notify(`Agent solved it in ${game.guesses.length}: ${word}`);
      return { ok: true, message: `✅ ${word} — solved in ${game.guesses.length}!` };
    }

    if (game.guesses.length >= MAX_GUESSES) {
      game.status = "lost";
      await ctx.state.set(game);
      ctx.notify(`Agent failed after ${MAX_GUESSES} guesses.`);
      return { ok: true, result: toEmoji(result), message: `❌ Game over. ${MAX_GUESSES} guesses used.` };
    }

    await ctx.state.set(game);
    const left = MAX_GUESSES - game.guesses.length;
    return {
      ok: true,
      message: `${word}: ${toEmoji(result)} — ${left} guess${left === 1 ? "" : "es"} remaining`,
    };
  },

  status: async (ctx: MoveApiContext) => {
    const state = await ctx.state.get<WordleState>();
    const game = state ?? newGame();
    // Return structured JSON in message so the widget can parse it without regex.
    // Answer is intentionally excluded.
    const payload = {
      guesses: game.guesses,
      results: game.results,
      status: game.status,
      guessesUsed: game.guesses.length,
      guessesLeft: MAX_GUESSES - game.guesses.length,
    };
    return { ok: true, message: JSON.stringify(payload) };
  },

  new: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    // Only allow user (widget) to reset — agent should play through to conclusion
    if (ctx.caller === "agent") {
      return { ok: false, error: "Agent cannot start a new game directly." };
    }
    const wordArg = typeof data.word === "string" ? data.word.trim() : undefined;
    if (wordArg && (wordArg.length !== 5 || !/^[A-Za-z]+$/.test(wordArg))) {
      return { ok: false, error: "Word must be exactly 5 letters." };
    }
    const fresh = newGame(wordArg);
    await ctx.state.set(fresh);
    return { ok: true, message: "New game started." };
  },
};
