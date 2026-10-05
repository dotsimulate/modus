/** Connection-local transport only. Reducers and durable history still see full snapshots. */
type Snapshot = { type: "system"; subtype: "live_snapshot"; text: string; thinking: string; feed: string };
type Patch = [keep: number, suffix: string];
type Delta = Omit<Snapshot, "subtype" | "text" | "thinking" | "feed"> & {
  subtype: "live_delta";
  base: number;
  text: Patch;
  thinking: Patch;
  feed: Patch;
};
type Previous = { seq: number; snapshot: Snapshot };

function isSnapshot(event: any): event is Snapshot {
  return event?.type === "system" && event.subtype === "live_snapshot"
    && typeof event.text === "string" && typeof event.thinking === "string" && typeof event.feed === "string";
}

function patch(previous: string, next: string): Patch {
  // Append is the common case. Replacement also covers resets and rolling feeds.
  return next.startsWith(previous) ? [previous.length, next.slice(previous.length)] : [0, next];
}

function apply(previous: string, value: Patch): string {
  if (!Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[0])
    || value[0] < 0 || value[0] > previous.length || typeof value[1] !== "string") {
    throw new Error("Invalid live snapshot delta");
  }
  return previous.slice(0, value[0]) + value[1];
}

/** Use only after an explicit liveDeltas: true request; create anew on reconnect. */
export function createLiveSnapshotEncoder() {
  const previous = new Map<string, Previous>();
  return (sid: string, seq: number, event: any): any => {
    if (!isSnapshot(event)) return event;
    const base = previous.get(sid);
    previous.set(sid, { seq, snapshot: event });
    if (!base) return event;
    const delta: Delta = {
      ...event,
      subtype: "live_delta",
      base: base.seq,
      text: patch(base.snapshot.text, event.text),
      thinking: patch(base.snapshot.thinking, event.thinking),
      feed: patch(base.snapshot.feed, event.feed),
    };
    const retained = delta.text[0] + delta.thinking[0] + delta.feed[0];
    // Small/reset snapshots cost less as ordinary full events.
    return retained > 128 ? delta : event;
  };
}

/** Throw before advancing the resume cursor on a gap, so the client reconnects. */
export function createLiveSnapshotDecoder() {
  const previous = new Map<string, Previous>();
  return (sid: string, seq: number, event: any): any => {
    if (isSnapshot(event)) previous.set(sid, { seq, snapshot: event });
    if (event?.type !== "system" || event.subtype !== "live_delta") return event;
    const base = previous.get(sid);
    if (!base || base.seq !== event.base) throw new Error("Missing live snapshot delta base");
    const { base: _base, ...fields } = event;
    const snapshot: Snapshot = {
      ...fields,
      subtype: "live_snapshot",
      text: apply(base.snapshot.text, event.text),
      thinking: apply(base.snapshot.thinking, event.thinking),
      feed: apply(base.snapshot.feed, event.feed),
    };
    previous.set(sid, { seq, snapshot });
    return snapshot;
  };
}
