export function hasUnreadReply(session: { last_reply_seq?: number; read_reply_seq?: number }): boolean {
  return (session.last_reply_seq ?? 0) > (session.read_reply_seq ?? 0);
}

export function canReadReply(
  seq: number, session: { last_reply_seq?: number; read_reply_seq?: number },
  visible: boolean, focused: boolean,
): boolean {
  return visible && focused && seq > (session.read_reply_seq ?? 0)
    && seq === session.last_reply_seq;
}
