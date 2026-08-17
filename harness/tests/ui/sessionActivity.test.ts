import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { sessionActivityAt } from "../../ui/src/sessionActivity";

const DAY = 86_400_000;

describe("sessionActivityAt", () => {
  it("uses the last message, not the last row write", () => {
    const now = Date.now();
    // A three-day-old conversation that was renamed a moment ago: the rename
    // wrote updated_at, the conversation itself has not moved.
    const renamed = { last_message_at: now - 3 * DAY, created_at: now - 4 * DAY, updated_at: now };
    expect(sessionActivityAt(renamed)).toBe(now - 3 * DAY);
  });

  it("does not move a session into today when it is pinned and unpinned", () => {
    const now = Date.now();
    const before = { last_message_at: now - 5 * DAY, created_at: now - 5 * DAY, updated_at: now - 5 * DAY };
    // Pin and unpin are tag writes; both touch updated_at and nothing else.
    const afterPin = { ...before, updated_at: now - 60_000 };
    const afterUnpin = { ...before, updated_at: now };
    expect(sessionActivityAt(afterPin)).toBe(sessionActivityAt(before));
    expect(sessionActivityAt(afterUnpin)).toBe(sessionActivityAt(before));
  });

  it("falls back to creation time before row-write time for a session with no messages", () => {
    const now = Date.now();
    const fresh = { last_message_at: 0, created_at: now - 2 * DAY, updated_at: now };
    expect(sessionActivityAt(fresh)).toBe(now - 2 * DAY);
    const nulls = { last_message_at: null, created_at: null, updated_at: now };
    expect(sessionActivityAt(nulls)).toBe(now);
  });

  it("returns 0 rather than NaN when a row carries none of the three", () => {
    expect(sessionActivityAt({})).toBe(0);
  });
});

describe("sidebar grouping contract", () => {
  // The sidebar buckets by age; these are the boundaries it uses.
  function bucket(ageMs: number): string {
    if (ageMs < DAY) return "today";
    if (ageMs < 2 * DAY) return "yesterday";
    if (ageMs < 7 * DAY) return "this week";
    return "older";
  }

  it("keeps a renamed week-old session out of today", () => {
    const now = Date.now();
    const s = { last_message_at: now - 5 * DAY, created_at: now - 6 * DAY, updated_at: now };
    expect(bucket(now - sessionActivityAt(s))).toBe("this week");
    // The defect this pins: bucketing on updated_at put it in "today".
    expect(bucket(now - (s.updated_at ?? 0))).toBe("today");
  });
});

describe("session-list surfaces order by conversation time", () => {
  // The original fix swept only the sidebar SessionList; the rename affordance
  // lives in the session-history widget, which kept bucketing and sorting on
  // row-write time — so renaming a chat still moved it to "now". Every surface
  // that lists sessions must read sessionActivityAt, never the raw column.
  const surfaces = [
    "components/sidebar/SessionList.tsx",
    "components/sidebar/SessionItem.tsx",
    "widgets/session-history.widget.tsx",
    "widgets/session-streams.widget.tsx",
    "widgets/missions.widget.tsx",
    "sessionHistoryVisibility.ts",
  ];

  for (const surface of surfaces) {
    it(`${surface} does not touch the row-write timestamp`, () => {
      const body = readFileSync(join(import.meta.dir, "../../ui/src", surface), "utf8");
      expect(body).not.toContain(".updated_at");
    });
  }
});
