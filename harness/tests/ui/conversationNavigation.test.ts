import { describe, expect, test } from "bun:test";
import { resolveMissingPageNavigation } from "../../ui/src/conversation-navigation";

describe("conversation-preserving missing page navigation", () => {
  test("waits until discovery describes the destination cwd", () => {
    expect(resolveMissingPageNavigation({
      customPageId: "project:focus",
      activeCustomPage: false,
      projectCwd: "B",
      pagesDiscoveredFor: "A",
      sessionId: "session-b",
    })).toBe("wait");
  });

  test("keeps a selected session in chat after confirmed absence", () => {
    expect(resolveMissingPageNavigation({
      customPageId: "project:focus",
      activeCustomPage: false,
      projectCwd: "B",
      pagesDiscoveredFor: "B",
      sessionId: "session-b",
    })).toBe("chat");
  });

  test("uses home only when no session exists", () => {
    expect(resolveMissingPageNavigation({
      customPageId: "missing",
      activeCustomPage: false,
      projectCwd: "B",
      pagesDiscoveredFor: "B",
      sessionId: null,
    })).toBe("home");
  });

  test("does nothing for a present page or a non-page view", () => {
    expect(resolveMissingPageNavigation({
      customPageId: "present",
      activeCustomPage: true,
      pagesDiscoveredFor: null,
    })).toBe("none");
    expect(resolveMissingPageNavigation({
      customPageId: null,
      activeCustomPage: false,
      pagesDiscoveredFor: null,
    })).toBe("none");
  });
});
