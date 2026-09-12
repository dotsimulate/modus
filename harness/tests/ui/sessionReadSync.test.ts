import { expect, test } from "bun:test";
import { modus } from "../../ui/src/modusClient";
import { applySessionReadReceipt, getSessionIndexSnapshot, handleSessionIndexLifecycleEvent, refreshSessionIndex } from "../../ui/src/sessionIndexSync";
import type { SessionIndex, SessionInfo } from "../../sdk/index";

test("a delayed session snapshot cannot undo a completion or read receipt", async () => {
  const original = modus.getSessionIndex;
  const session = { id: "read-sync-fixture", last_reply_seq: 10, read_reply_seq: 0 } as SessionInfo;
  const snapshot: SessionIndex = { generated_at: 1, projects: [], sessions: [session] };
  modus.getSessionIndex = async () => snapshot;
  try {
    await refreshSessionIndex();
    applySessionReadReceipt(session.id, { last_reply_seq: 20, read_reply_seq: 10 });
    const refreshed = await refreshSessionIndex();
    expect(refreshed.sessions[0]).toMatchObject({ last_reply_seq: 20, read_reply_seq: 10 });
    applySessionReadReceipt(session.id, { last_reply_seq: 10, read_reply_seq: 5 });
    expect(getSessionIndexSnapshot()!.sessions[0]).toMatchObject({ last_reply_seq: 20, read_reply_seq: 10 });
  } finally {
    modus.getSessionIndex = original;
  }
});

test("streaming sessions excluded from the index do not trigger a snapshot per event", async () => {
  const original = modus.getSessionIndex;
  let reads = 0;
  modus.getSessionIndex = async () => {
    reads++;
    return { generated_at: Date.now(), projects: [], sessions: [] };
  };
  try {
    await refreshSessionIndex();
    for (let i = 0; i < 250; i++) {
      await handleSessionIndexLifecycleEvent({ type: "session:activity", sessionId: "internal-fixture", seq: i });
    }
    expect(reads).toBe(1);
    await handleSessionIndexLifecycleEvent({ type: "session:created", sessionId: "new-fixture" });
    expect(reads).toBe(2);
  } finally {
    modus.getSessionIndex = original;
  }
});
