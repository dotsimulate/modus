/**
 * Classified move activation failures.
 *
 * A move that fails to load is the quietest failure in the product. The loader
 * catches the error, logs it, and injects nothing; the chip still attaches in the
 * composer, the user still sends, and the agent simply never receives the
 * context. In a packaged build there are no devtools, so the only trace is a line
 * in the backend log — the user sees a move that "attached but did nothing".
 *
 * This module turns those failures into something a session can show. Two rules
 * shape it:
 *
 *   - **Classify, do not paraphrase.** The reason is a closed set, so the UI and
 *     any future caller can branch on it rather than matching message text.
 *   - **The detail is untrusted.** It comes from an authored move's exception, a
 *     module resolution error, or a plugin, and it is about to be persisted into
 *     a session transcript. Absolute paths are reduced to their final segment,
 *     stack traces are dropped, and the result is length-capped.
 *
 * Pure — no filesystem, no database, no session.
 */

export type MoveActivationFailureReason =
  /** The move directory or move.json could not be resolved for this project. */
  | "not-found"
  /** context.ts exists but could not be imported (syntax error, unbridged import, bad dependency). */
  | "load-failed"
  /** gather() threw. */
  | "gather-failed"
  /** gather() produced nothing — no gather() export, it returned null, or it timed out. */
  | "gather-empty"
  /** A persistent move failed to activate. */
  | "activation-failed";

export interface MoveActivationFailure {
  moveName: string;
  reason: MoveActivationFailureReason;
  /** Sanitized single-line explanation. Never a stack trace or a full host path. */
  detail: string;
}

/** Longest detail we will persist into a transcript. */
const DETAIL_LIMIT = 300;

const REASON_PHRASE: Record<MoveActivationFailureReason, string> = {
  "not-found": "was not found in this project",
  "load-failed": "failed to load its context.ts",
  "gather-failed": "failed while gathering context",
  "gather-empty": "gathered no context (no gather() export, it returned null, or it timed out)",
  "activation-failed": "could not be activated",
};

/**
 * Reduce an absolute path to its final segment.
 *
 * The file name is the part that helps ("context.ts failed to import"); the
 * directory chain above it is the user's machine layout, which does not belong
 * in a transcript that may be shared or exported.
 */
export function redactPaths(text: string): string {
  const windowsPath = /[A-Za-z]:[\\/][^\s"'()]*/g;
  const posixPath = /(?:\/[^\s"'()/]+){2,}\/?/g;
  return text
    .replace(windowsPath, (match) => shortenPath(match))
    .replace(posixPath, (match) => shortenPath(match));
}

function shortenPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? `.../${last}` : path;
}

/** Turn an arbitrary thrown value into one safe, bounded line. */
export function sanitizeFailureDetail(error: unknown): string {
  let message: string;
  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  else if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    message = (error as { message: string }).message;
  } else message = String(error ?? "");

  // First line only: everything after it is a stack trace.
  const firstLine = message.split(/\r?\n/)[0] ?? "";
  const redacted = redactPaths(firstLine).trim();
  if (!redacted) return "no reason reported";
  return redacted.length > DETAIL_LIMIT ? `${redacted.slice(0, DETAIL_LIMIT - 1)}…` : redacted;
}

export function describeMoveActivationFailure(
  moveName: string,
  reason: MoveActivationFailureReason,
  error?: unknown,
): MoveActivationFailure {
  return {
    moveName,
    reason,
    detail: error === undefined ? REASON_PHRASE[reason] : sanitizeFailureDetail(error),
  };
}

/**
 * Render failures as the system message a session shows.
 *
 * Says what did not happen ("no context was injected"), because that is the part
 * the user cannot otherwise deduce: the move chip attached normally.
 */
export function formatMoveActivationFailures(failures: MoveActivationFailure[]): string {
  if (failures.length === 0) return "";
  const lines = failures.map((failure) => {
    const phrase = REASON_PHRASE[failure.reason];
    const detail = failure.detail && failure.detail !== phrase ? ` — ${failure.detail}` : "";
    return `- **${failure.moveName}** ${phrase}${detail}`;
  });
  const subject = failures.length === 1 ? "move" : "moves";
  return [
    `${failures.length} attached ${subject} did not run, so no context was injected:`,
    "",
    ...lines,
  ].join("\n");
}
