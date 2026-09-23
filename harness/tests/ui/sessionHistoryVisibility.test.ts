import { describe, expect, test } from "bun:test";
import { selectCycleSessionIds, selectVisibleGroupSessions, selectVisibleProjectSessions } from "../../ui/src/sessionHistoryVisibility";

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

  test("keeps a session with an unread reply visible past the window", () => {
    const sessions = [
      session("recent", 1),
      { ...session("unread-old", 200), last_reply_seq: 4, read_reply_seq: 2 },
      { ...session("read-old", 200), last_reply_seq: 4, read_reply_seq: 4 },
    ];
    expect(selectVisibleProjectSessions(sessions, {
      window: "12h",
      now: NOW,
      recentLimit: 8,
    }).map((item) => item.id)).toEqual(["recent", "unread-old"]);
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

describe("timeline, agent, and status group visibility", () => {
  test("caps a group by count without applying a time window to it", () => {
    // Every session here is weeks old: a time cutoff would empty the bucket,
    // where the count cap keeps its head.
    const sessions = Array.from({ length: 9 }, (_, index) => session(`old-${index}`, 400 + index));
    expect(selectVisibleGroupSessions(sessions, { limit: 5 }).map((item) => item.id))
      .toEqual(["old-0", "old-1", "old-2", "old-3", "old-4"]);
  });

  test("live, unread, and selected rows survive the cap", () => {
    const sessions = [
      ...Array.from({ length: 5 }, (_, index) => session(`fill-${index}`, index + 1)),
      session("running-old", 500, "running"),
      { ...session("unread-old", 600), last_reply_seq: 3, read_reply_seq: 1 },
      session("selected-old", 700),
      session("buried", 800),
    ];
    expect(selectVisibleGroupSessions(sessions, { limit: 5, selectedId: "selected-old" })
      .map((item) => item.id)).toEqual([
      "fill-0", "fill-1", "fill-2", "fill-3", "fill-4",
      "running-old", "unread-old", "selected-old",
    ]);
  });

  test("reveal grows the group and search bypasses the cap", () => {
    const sessions = Array.from({ length: 9 }, (_, index) => session(`s-${index}`, index + 1));
    expect(selectVisibleGroupSessions(sessions, { limit: 5, revealCount: 2 })).toHaveLength(7);
    expect(selectVisibleGroupSessions(sessions, { limit: 5, revealCount: 99 })).toHaveLength(9);
    expect(selectVisibleGroupSessions(sessions, { limit: 5, searching: true })).toHaveLength(9);
  });
});

describe("session cycle ring", () => {
  const row = (id: string) => ({ id });

  test("walks pinned then visible rows of open groups, never hidden or collapsed ones", () => {
    const groups = [
      { key: "a", visibleSessions: [row("a1"), row("a2")] }, // a3 sits behind "show more"
      { key: "b", visibleSessions: [row("b1")] },            // collapsed
      { key: "c", visibleSessions: [row("c1"), row("pending-x")] },
    ];
    expect(selectCycleSessionIds([row("p1")], groups, new Set(["a", "c"])))
      .toEqual(["p1", "a1", "a2", "c1"]);
  });

  test("with nothing open or pinned, visible rows of every group stand in", () => {
    const groups = [
      { key: "a", visibleSessions: [row("a1")] },
      { key: "b", visibleSessions: [row("b1")] },
    ];
    expect(selectCycleSessionIds([], groups, new Set())).toEqual(["a1", "b1"]);
  });
});
