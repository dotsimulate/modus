import { expect, test } from "bun:test";
import { canReadReply, hasUnreadReply } from "../../ui/src/session-read-state";

test("runtime status and old history are independent of unread replies", () => {
  expect(hasUnreadReply({})).toBe(false);
  expect(hasUnreadReply({ last_reply_seq: 20, read_reply_seq: 0 })).toBe(true);
  expect(hasUnreadReply({ last_reply_seq: 20, read_reply_seq: 20 })).toBe(false);
});

test("only the current completed reply in a focused visible conversation clears unread", () => {
  const state = { last_reply_seq: 20, read_reply_seq: 10 };
  expect(canReadReply(20, state, true, true)).toBe(true);
  expect(canReadReply(19, state, true, true)).toBe(false);
  expect(canReadReply(21, state, true, true)).toBe(false);
  expect(canReadReply(20, state, false, true)).toBe(false);
  expect(canReadReply(20, state, true, false)).toBe(false);
  expect(canReadReply(20, { ...state, read_reply_seq: 20 }, true, true)).toBe(false);
});
