import { memo, useState } from "react";
import type { BranchPreview, Message } from "../../../sdk/index";
import { modus } from "../modusClient";
import { BranchReviewDialog } from "./BranchReviewDialog";

type Props = {
  msg: Message;
  sessionId?: string | null;
  provider?: string | null;
  onBranch?: (seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => void | Promise<void>;
};

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const UserMeta = memo(function UserMeta({ msg, sessionId, provider, onBranch }: Props) {
  const [preview, setPreview] = useState<BranchPreview | null>(null);
  const [restoreCode, setRestoreCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!msg.timestamp) return null;

  const openPreview = async (withCode: boolean) => {
    if (msg.seq == null || !sessionId) return;
    setRestoreCode(withCode);
    setPreview(null);
    setError(null);
    setLoading(true);
    try {
      const branchAt = Math.max(1, msg.seq - 1);
      setPreview(await modus.previewBranch(sessionId, branchAt, withCode
        ? { restoreCode: true, checkpointSeq: msg.seq, providerMessageId: msg.uuid ?? undefined }
        : undefined));
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const confirm = async () => {
    if (msg.seq == null || !preview?.conversation.supported || preview.workspace?.status === "unsupported") return;
    setApplying(true);
    setError(null);
    try {
      await onBranch?.(msg.seq, msg.content, restoreCode, msg.uuid ?? undefined);
      setPreview(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="user-meta">
      <span className="user-meta-time">{formatDateTime(msg.timestamp)}</span>
      {onBranch && (
        <>
          <button type="button" className="user-meta-branch" onClick={() => void openPreview(false)}>
            branch conversation
          </button>
          <button type="button" className="user-meta-branch" onClick={() => void openPreview(true)}>
            rewind code + chat
          </button>
        </>
      )}

      {(loading || preview || error) && (
        <BranchReviewDialog
          restoreCode={restoreCode}
          loading={loading}
          applying={applying}
          error={error}
          preview={preview}
          provider={provider}
          onCancel={() => { setPreview(null); setError(null); }}
          onConfirm={() => void confirm()}
        />
      )}
    </div>
  );
});
