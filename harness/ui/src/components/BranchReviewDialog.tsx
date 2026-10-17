import type { BranchPreview } from "../../../sdk/index";

type Props = {
  restoreCode: boolean;
  loading: boolean;
  applying: boolean;
  error: string | null;
  preview: BranchPreview | null;
  provider?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

/** Whether a reviewed branch can be applied as previewed. */
export function canConfirmBranch(preview: BranchPreview | null, restoreCode: boolean): boolean {
  return !!preview?.conversation.supported
    && (!restoreCode || (preview.workspace != null && preview.workspace.status !== "unsupported"));
}

/**
 * The review step every branch goes through. The server refuses a branch that
 * was not confirmed after a fresh preview, so this is the only way one is made.
 */
export function BranchReviewDialog({ restoreCode, loading, applying, error, preview, provider, onCancel, onConfirm }: Props) {
  const canConfirm = canConfirmBranch(preview, restoreCode);
  return (
    <div className="rewind-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !applying) onCancel();
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
          <button type="button" onClick={onCancel} disabled={applying}>Cancel</button>
          <button type="button" className="rewind-confirm" onClick={onConfirm} disabled={!canConfirm || applying || loading}>
            {applying ? "Applying…" : restoreCode
              ? preview?.workspace?.status === "partial" ? "Confirm partial rewind and branch" : "Confirm rewind and branch"
              : "Confirm branch"}
          </button>
        </div>
      </section>
    </div>
  );
}
