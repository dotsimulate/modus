import { describe, expect, it } from "bun:test";
import { formatClientTimingLog, parseClientTimingPayload } from "../client-timing";

describe("client timing diagnostics", () => {
  it("accepts a bounded Tauri timing payload", () => {
    const payload = parseClientTimingPayload({
      renderer: "tauri",
      metric: "clientExtensions",
      durationMs: 643.04,
      outcome: "loaded",
      session: "01a00450",
      source: "profile-project",
    });
    expect(payload).toEqual({
      renderer: "tauri",
      metric: "clientExtensions",
      durationMs: 643.04,
      outcome: "loaded",
      session: "01a00450",
      source: "profile-project",
    });
    expect(formatClientTimingLog(payload!)).toBe(
      "[CLIENT-TIMING] renderer=tauri metric=clientExtensions duration=643.0ms outcome=loaded session=01a00450 source=profile-project",
    );
  });

  it("rejects unbounded or log-injectable fields", () => {
    expect(parseClientTimingPayload({ renderer: "browser", metric: "projectUiTheme", durationMs: 10 })).toBeNull();
    expect(parseClientTimingPayload({ renderer: "tauri", metric: "arbitrary\nlog", durationMs: 10 })).toBeNull();
    expect(parseClientTimingPayload({ renderer: "tauri", metric: "projectUiTheme", durationMs: -1 })).toBeNull();
    expect(parseClientTimingPayload({ renderer: "tauri", metric: "projectUiTheme", durationMs: 10, session: "bad value" })).toBeNull();
    expect(parseClientTimingPayload({ renderer: "tauri", metric: "applyEventBatch", durationMs: 10, count: 1_000_001 })).toBeNull();
    expect(parseClientTimingPayload({ renderer: "tauri", metric: "projectUiTheme", durationMs: 10, source: "anything" })).toBeNull();
  });
});
