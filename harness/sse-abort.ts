/**
 * Run `onAbort` when an SSE client disconnects — including when it already has.
 *
 * `addEventListener("abort")` never fires for a signal that is already aborted,
 * and Bun's writes to a closed direct stream return 0 instead of throwing. A
 * client that disconnects while a handler is still awaiting catch-up writes
 * would otherwise leave the handler, its session subscriptions, and the
 * half-closed socket (CLOSE_WAIT) alive for the life of the process.
 */
export function onClientAbort(signal: AbortSignal, onAbort: () => void): void {
  signal.addEventListener("abort", onAbort);
  if (signal.aborted) onAbort();
}
