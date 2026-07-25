type ErrorEmitter = {
  on(event: "error", listener: (error: unknown) => void): unknown;
  off?(event: "error", listener: (error: unknown) => void): unknown;
};

const EXPECTED_PIPE_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

/** Return a stable error code without copying potentially sensitive messages. */
export function pipeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code ? code : "UNKNOWN";
}

export function isExpectedPipeError(error: unknown): boolean {
  return EXPECTED_PIPE_ERROR_CODES.has(pipeErrorCode(error));
}

function notifySafely(handler: (error: unknown) => void, error: unknown): void {
  try {
    handler(error);
  } catch {
    // An error listener must never throw back into EventEmitter's special
    // "error" path, which would turn a local pipe failure into a backend crash.
    console.error("[pipe] local error handler failed");
  }
}

/**
 * Install a non-throwing listener immediately after a writable stream is
 * created. The returned function is optional cleanup for long-lived streams.
 */
export function attachPipeErrorHandler(
  stream: ErrorEmitter,
  handler: (error: unknown) => void,
): () => void {
  const listener = (error: unknown) => notifySafely(handler, error);
  stream.on("error", listener);
  return () => {
    try { stream.off?.("error", listener); } catch {}
  };
}

/** Convert a synchronous write/resize/end failure into a local false result. */
export function tryPipeOperation(
  operation: () => void,
  handler: (error: unknown) => void,
): boolean {
  try {
    operation();
    return true;
  } catch (error) {
    notifySafely(handler, error);
    return false;
  }
}

