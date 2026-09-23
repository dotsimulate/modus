import { expect, test } from "bun:test";
import { modus } from "../../ui/src/modusClient";
import { getSessionIndexSnapshot, handleSessionIndexLifecycleEvent, refreshSessionIndex } from "../../ui/src/sessionIndexSync";
import type { SessionIndex, SessionInfo } from "../../sdk/index";

test("a title written after the session settled reaches the index without a refetch", async () => {
  const original = modus.getSessionIndex;
  let reads = 0;
  const session = { id: "title-sync-fixture", title: null, preview: "opening message" } as SessionInfo;
  modus.getSessionIndex = async (): Promise<SessionIndex> => {
    reads++;
    return { generated_at: 1, projects: [], sessions: [session] };
  };
  try {
    await refreshSessionIndex();
    await handleSessionIndexLifecycleEvent({ type: "session:title", sessionId: session.id, title: "Repo status check" });
    expect(getSessionIndexSnapshot()!.sessions[0]).toMatchObject({ title: "Repo status check", preview: "opening message" });
    await handleSessionIndexLifecycleEvent({ type: "session:title", sessionId: session.id, title: null });
    expect(getSessionIndexSnapshot()!.sessions[0]!.title).toBeNull();
    expect(reads).toBe(1);
  } finally {
    modus.getSessionIndex = original;
  }
});
