import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow, resolveViewMode } from "../src/widgets/session-history.widget";
import type { SessionInfo } from "../../sdk/index";

const NOW = 1_800_000_000_000;

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1", preview: "", title: "deploy check", profile: "core", provider: "claude",
    model: "claude-opus-5", status: "done", created_at: NOW, updated_at: NOW,
    last_message_at: NOW, message_count: 4, total_cost_usd: 0, last_prompt: null,
    last_response: null, cwd: null, user_profile: null, project_id: "p1",
    project_name: "modus", project_root: null, project_explicit: true,
    action_name: null, tags: "", ...overrides,
  };
}

const props = {
  selected: false, hovered: false, onHover: () => {}, onSelect: () => {},
  onArchive: () => {}, onTogglePin: () => {}, onRename: () => {},
  isPinned: false, showProject: false,
};

test("a reply the user has not read is called out on the row", () => {
  const html = renderToStaticMarkup(createElement(SessionRow, {
    ...props, session: session({ last_reply_seq: 4, read_reply_seq: 2 }),
  }));
  expect(html).toContain("sh-row--unread");
  expect(html).toContain("new reply");
});

test("a read session carries no unread marking", () => {
  const html = renderToStaticMarkup(createElement(SessionRow, {
    ...props, session: session({ last_reply_seq: 4, read_reply_seq: 4 }),
  }));
  expect(html).not.toContain("sh-row--unread");
  expect(html).not.toContain("new reply");
});

test("reading the last waiting reply hands the unread view back to projects", () => {
  expect(resolveViewMode("unread", 2, true)).toBe("unread");
  expect(resolveViewMode("unread", 1, true)).toBe("unread");
  expect(resolveViewMode("unread", 0, true)).toBe("projects");
});

test("an unloaded index is not mistaken for nothing left to read", () => {
  expect(resolveViewMode("unread", 0, false)).toBe("unread");
});

test("an empty unread count leaves every other view alone", () => {
  expect(resolveViewMode("projects", 0, true)).toBe("projects");
  expect(resolveViewMode("timeline", 0, true)).toBe("timeline");
  expect(resolveViewMode("agents", 0, true)).toBe("agents");
  expect(resolveViewMode("status", 0, true)).toBe("status");
});
