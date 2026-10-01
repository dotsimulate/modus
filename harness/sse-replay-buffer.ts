import type { SSEWriter } from "./session-manager";

/** Subscribe before reading history, then hold live writes until replay ends.
 * A snapshot taken after an awaited flush can otherwise skip a durable prompt
 * that arrived during catch-up. Bound the buffer; overflow closes the connection
 * so the client retries from its last delivered cursor. */
export function createSSEReplayBuffer(
  target: SSEWriter,
  canWrite: () => boolean,
  onOverflow: () => void = () => target.close(),
) {
  const pending: Array<{ event: string; data: string; id: string } | null> = [];
  let buffering = true;
  let disposed = false;
  const writer: SSEWriter = {
    write(event, data, id) {
      if (disposed || !canWrite()) return Promise.resolve();
      if (!buffering) return target.write(event, data, id);
      if (pending.length >= 256) {
        disposed = true;
        pending.length = 0;
        onOverflow();
        return Promise.resolve();
      }
      pending.push({ event, data, id });
      return Promise.resolve();
    },
    close() {
      if (disposed) return;
      if (buffering) pending.push(null);
      else target.close();
    },
  };
  return {
    writer,
    async flush() {
      while (pending.length && !disposed && canWrite()) {
        const next = pending.shift();
        if (next) await target.write(next.event, next.data, next.id);
        else target.close();
      }
      buffering = false;
    },
    dispose() {
      disposed = true;
      pending.length = 0;
    },
  };
}
