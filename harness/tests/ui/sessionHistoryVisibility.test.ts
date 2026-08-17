import { describe, expect, test } from "bun:test";
import { selectVisibleProjectSessions } from "../../ui/src/sessionHistoryVisibility";

const NOW = 1_800_000_000_000;

function session(id: string, ageHours: number, status = "done") {
  const at = NOW - ageHours * 60 * 60 * 1000;
  return { id, status, last_message_at: at, created_at: at, updated_at: at };
}

describe("project session visibility", () => {
  test("shows active sessions regardless of age and caps recent inactive sessions", () => {
    const sessions = [
      session("active-old", 200, "running"),
      ...Array.from({ length: 12 }, (_, index) => session(`recent-${index}`, index + 1)),
      session("old", 48),
    ];
    const visible = selectVisibleProjectSessions(sessions, { window: "12h", now: NOW, recentLimit: 8 });
    expect(visible.map((item) => item.id)).toEqual([
      "active-old",
      ...Array.from({ length: 8 }, (_, index) => `recent-${index}`),
    ]);
  });

  test("keeps an old selected session visible", () => {
    const sessions = [session("recent", 1), session("selected-old", 200), session("old", 300)];
    expect(selectVisibleProjectSessions(sessions, {
      window: "12h",
      now: NOW,
      selectedId: "selected-old",
    }).map((item) => item.id)).toEqual(["recent", "selected-old"]);
  });

  test("does not make an old conversation recent when reap touches its row", () => {
    const recent = session("recent", 1);
    const reaped = { ...session("reaped-old", 200), updated_at: NOW - 5 * 60_000 };
    expect(selectVisibleProjectSessions([recent, reaped], {
      window: "12h",
      now: NOW,
      recentLimit: 8,
    }).map((item) => item.id)).toEqual(["recent"]);
  });

  test("reveals older sessions incrementally", () => {
    const sessions = [session("recent", 1), session("old-1", 24), session("old-2", 48)];
    expect(selectVisibleProjectSessions(sessions, {
      window: "12h",
      now: NOW,
      revealCount: 1,
    }).map((item) => item.id)).toEqual(["recent", "old-1"]);
  });

  test("search and all mode bypass project visibility limits", () => {
    const sessions = [session("recent", 1), session("old", 200)];
    expect(selectVisibleProjectSessions(sessions, { window: "12h", now: NOW, searching: true })).toHaveLength(2);
    expect(selectVisibleProjectSessions(sessions, { window: "all", now: NOW })).toHaveLength(2);
  });
});
