import { describe, expect, it } from "bun:test";
import { rememberChatScrollAnchor, type ChatScrollAnchor } from "../../ui/src/chat-scroll-anchor";

// Three 1000px messages in an 800px viewport: 2200px of scroll range.
const layout = {
  offsets: new Map([["a", 0], ["b", 1000], ["c", 2000]]),
  heights: new Map([["a", 1000], ["b", 1000], ["c", 1000]]),
};
const scroller = (scrollTop: number, overrides: Partial<{ isConnected: boolean; clientHeight: number }> = {}) => ({
  isConnected: true,
  scrollTop,
  scrollHeight: 3000,
  clientHeight: 800,
  ...overrides,
});

describe("rememberChatScrollAnchor", () => {
  it("anchors to the first item crossing the viewport top", () => {
    const store = new Map<string, ChatScrollAnchor>();
    expect(rememberChatScrollAnchor(store, "s", scroller(1250), layout))
      .toEqual({ key: "b", within: 250, atBottom: false });
    expect(store.get("s")).toEqual({ key: "b", within: 250, atBottom: false });
  });

  it("marks a reader at the live edge so a remount reopens on the last message", () => {
    const store = new Map<string, ChatScrollAnchor>();
    expect(rememberChatScrollAnchor(store, "s", scroller(2200), layout)?.atBottom).toBe(true);
  });

  it("keeps the last real position when the scroller has left the document", () => {
    const store = new Map<string, ChatScrollAnchor>();
    rememberChatScrollAnchor(store, "s", scroller(2200), layout);
    // An unmount cleanup reads a detached scroller as scrollTop 0.
    expect(rememberChatScrollAnchor(store, "s", scroller(0, { isConnected: false, clientHeight: 0 }), layout)).toBeNull();
    expect(store.get("s")?.atBottom).toBe(true);
  });

  it("ignores a hidden scroller", () => {
    const store = new Map<string, ChatScrollAnchor>();
    expect(rememberChatScrollAnchor(store, "s", scroller(0, { clientHeight: 0 }), layout)).toBeNull();
    expect(store.has("s")).toBe(false);
  });

  it("forgets the least recently saved sessions beyond thirty", () => {
    const store = new Map<string, ChatScrollAnchor>();
    for (let i = 0; i < 31; i++) rememberChatScrollAnchor(store, `s${i}`, scroller(0), layout);
    expect(store.size).toBe(30);
    expect(store.has("s0")).toBe(false);
    expect(store.has("s30")).toBe(true);
  });
});
