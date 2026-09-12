import { useEffect, useRef } from "react";
import { useSessionIndex } from "../providers/SessionContext";
import { modus } from "../modusClient";
import { applySessionReadReceipt } from "../sessionIndexSync";
import { canReadReply } from "../session-read-state";

/** A virtualized reply is read only once its end reaches the focused viewport. */
export function ReplyReadMarker({ sessionId, seq }: { sessionId: string; seq: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const index = useSessionIndex();
  const session = index?.allServerSessions.find((entry) => entry.id === sessionId);
  const lastReplySeq = session?.last_reply_seq;
  const readReplySeq = session?.read_reply_seq;

  useEffect(() => {
    const element = ref.current;
    if (!element || seq !== lastReplySeq || seq <= (readReplySeq ?? 0)) return;
    let visible = false;
    let pending = false;
    let read = false;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (disposed || pending || read || !canReadReply(seq, {
        last_reply_seq: lastReplySeq, read_reply_seq: readReplySeq,
      }, visible && document.visibilityState === "visible", document.hasFocus())) return;
      pending = true;
      modus.markSessionReplyRead(sessionId, seq).then((receipt) => {
        read = true;
        applySessionReadReceipt(sessionId, receipt);
      }).catch(() => {
        if (!disposed) retry = setTimeout(check, 5000);
      }).finally(() => { pending = false; });
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting && entry.intersectionRect.height > 0;
      check();
    });
    observer.observe(element);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      disposed = true;
      clearTimeout(retry);
      observer.disconnect();
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [sessionId, seq, lastReplySeq, readReplySeq]);

  return <div ref={ref} aria-hidden="true" style={{ height: 1 }} />;
}
