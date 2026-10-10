import { isAtBottom } from "./scroll-bottom-tracker";

/**
 * Where a reader was in a conversation, kept per session so remounting the
 * chat — navigating back to it, or switching between the conversation and card
 * projections — returns them there. An item anchor rather than a raw pixel, so
 * late measurements and prepended history do not move the target.
 */
export type ChatScrollAnchor = {
  key: string;
  within: number;
  /** The reader was at the live edge; reopen there rather than restoring. */
  atBottom: boolean;
};

export type ChatScrollAnchorLayout = {
  offsets: ReadonlyMap<string, number>;
  heights: ReadonlyMap<string, number>;
};

export type ChatScrollElement = {
  isConnected: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

const MAX_REMEMBERED_SESSIONS = 30;

export function rememberChatScrollAnchor(
  store: Map<string, ChatScrollAnchor>,
  sessionId: string,
  element: ChatScrollElement,
  layout: ChatScrollAnchorLayout | null,
): ChatScrollAnchor | null {
  // An unmount cleanup runs after the scroller has left the document, and a
  // hidden one has no box. Both read scrollTop as 0, which would record the
  // top of the conversation in place of the reader's real position.
  if (!element.isConnected || element.clientHeight === 0) return null;
  if (!layout || layout.offsets.size === 0) return null;
  const atBottom = isAtBottom(element);
  let anchor: ChatScrollAnchor | null = null;
  for (const [key, offset] of layout.offsets) {
    const height = layout.heights.get(key) ?? 0;
    if (offset + height > element.scrollTop) {
      anchor = { key, within: Math.max(0, element.scrollTop - offset), atBottom };
      break;
    }
  }
  if (!anchor) {
    const last = [...layout.offsets.keys()].at(-1);
    if (last) anchor = { key: last, within: layout.heights.get(last) ?? 0, atBottom };
  }
  if (!anchor) return null;
  store.delete(sessionId);
  store.set(sessionId, anchor);
  while (store.size > MAX_REMEMBERED_SESSIONS) {
    const oldest = store.keys().next().value;
    if (typeof oldest !== "string") break;
    store.delete(oldest);
  }
  return anchor;
}
