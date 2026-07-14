import { memo, useState } from "react";
import type { BranchPreview, Message } from "../../../sdk/index";
import { modus } from "../modusClient";

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

  const canConfirm = !!preview?.conversation.supported
    && (!restoreCode || (preview.workspace != null && preview.workspace.status !== "unsupported"));

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
        <div className="rewind-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !applying) { setPreview(null); setError(null); }
        }}>
          <section className="rewind-dialog" role="dialog" aria-modal="true" aria-labelledby="rewind-dialog-title">
            <h2 id="rewind-dialog-title">{restoreCode ? "Review code rewind and chat branch" : "Review conversation branch"}</h2>
            {loading && <p>Calculating provider support and exact file effects…</p>}
            {error && <p className="rewind-dialog-error">{error}</p>}
            {preview && (
              <>
                <div className="rewind-summary-row"><span>Conversation</span><strong>{preview.conversation.label}</strong></div>
                {preview.conversation.warning && <p className="rewind-dialog-warning">{preview.conversation.warning}</p>}
                <p className="rewind-dialog-fineprint">Provider: {provider ?? preview.provider}. This action creates a new chat; the current chat remains intact.</p>
                {restoreCode && preview.workspace && (
                  <>
                    <div className="rewind-summary-row">
                      <span>Workspace</span>
                      <strong>{preview.workspace.capability === "native-claude" ? "Claude native" : preview.workspace.capability === "modus" ? "Modus managed" : "Unsupported"} · {preview.workspace.status} · {preview.workspace.files.length} file action{preview.workspace.files.length === 1 ? "" : "s"}</strong>
                    </div>
                    {preview.workspace.error && <p className="rewind-dialog-error">{preview.workspace.error}</p>}
                    {preview.workspace.files.length > 0 ? (
                      <ul className="rewind-file-list">
                        {preview.workspace.files.map((file) => <li key={`${file.action}:${file.path}`}><b>{file.action}</b> {file.path}</li>)}
                      </ul>
                    ) : <p>No managed files currently differ from this checkpoint.</p>}
                    {preview.workspace.excluded.length > 0 && (
                      <details><summary>{preview.workspace.excluded.length} excluded path{preview.workspace.excluded.length === 1 ? "" : "s"} will not be touched</summary>
                        <ul className="rewind-file-list">{preview.workspace.excluded.map((file) => <li key={`${file.reason}:${file.path}`}>{file.path} — {file.reason}</li>)}</ul>
                      </details>
                    )}
                    {preview.workspace.scopeNotes.map((note) => <p className="rewind-dialog-fineprint" key={note}>{note}</p>)}
                    <p className="rewind-dialog-warning">The workspace is shared. These listed changes affect every chat and process using it. An undo checkpoint is captured immediately before restore.</p>
                  </>
                )}
              </>
            )}
            <div className="rewind-dialog-actions">
              <button type="button" onClick={() => { setPreview(null); setError(null); }} disabled={applying}>Cancel</button>
              <button type="button" className="rewind-confirm" onClick={() => void confirm()} disabled={!canConfirm || applying || loading}>
                {applying ? "Applying…" : restoreCode
                  ? preview?.workspace?.status === "partial" ? "Confirm partial rewind and branch" : "Confirm rewind and branch"
                  : "Confirm branch"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
});
