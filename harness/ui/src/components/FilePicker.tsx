/**
 * FilePicker — server-side file browser.
 *
 * The sibling of FolderPicker, and deliberately the same shape: an editable path
 * bar, a navigable listing, and one confirming action. It differs in that files
 * are listed alongside directories and selecting a *file* is the goal, so a file
 * row is the primary affordance and a directory row only navigates.
 *
 * Navigates the harness server's filesystem, not the browser's. There is no
 * `<input type="file">` here on purpose: move code runs on the server and opens
 * the path it is given, so a browser file handle would be useless to it.
 *
 * `accept` filters the listing by extension. It is a convenience, not the
 * boundary — the move's declared policy is re-enforced server-side at
 * activation (`harness/move-file-input.ts`).
 */

import { useEffect, useRef, useState } from "react";
import { modus } from "../modusClient";
import { acceptsFileName } from "../../../move-file-accept";
import { folderLabel } from "../folderPath";
import { browsedHost } from "../native-picker";
import type { BrowseResult } from "../../../sdk/index";

type Props = {
  onSelect: (path: string) => void;
  onCancel: () => void;
  /** Directory to open in. Falls back to the server's default when absent. */
  initialPath?: string;
  /** Extension allowlist, e.g. [".png", ".jpg"]. Empty shows every file. */
  accept?: string[];
  /** Shown in the header so the user knows what is being asked for. */
  title?: string;
};

export function FilePicker({ onSelect, onCancel, initialPath, accept, title }: Props) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const host = browsedHost();

  const navigate = (path?: string) => {
    setLoading(true);
    setError(null);
    // A selection belongs to the directory it was made in.
    setSelected(null);
    modus.browse(path, { includeFiles: true })
      .then((r) => {
        setResult(r);
        setPathInput(r.path);
        listRef.current?.scrollTo({ top: 0 });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    navigate(initialPath || undefined);
  }, []);

  const handlePathSubmit = () => {
    const p = pathInput.trim();
    if (p) navigate(p);
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handlePathSubmit();
    }
    if (e.key === "Escape") onCancel();
  };

  const joinPath = (dir: string, name: string) =>
    dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}/${name}`;

  const files = (result?.files ?? []).filter((name) => acceptsFileName(name, accept));
  const hiddenByFilter = (result?.files ?? []).length - files.length;

  return (
    <div className="file-picker">
      <div className="file-picker-header">
        <span className="file-picker-title">{title ?? "select file"}</span>
        {host && <span className="file-picker-host" title={`browsing the filesystem on ${host}`}>{host}</span>}
        <button className="file-picker-close" onClick={onCancel}>&times;</button>
      </div>

      <div className="file-picker-pathbar">
        <input
          className="file-picker-input"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={handlePathKeyDown}
          onBlur={handlePathSubmit}
          spellCheck={false}
          placeholder="/path/to/folder"
        />
      </div>

      <div className="file-picker-list" ref={listRef}>
        {loading && <div className="file-picker-loading">loading...</div>}
        {error && <div className="file-picker-error">{error}</div>}

        {!loading && result && (
          <>
            {result.parent && (
              <button
                className="file-picker-item file-picker-parent"
                onClick={() => navigate(result.parent!)}
              >
                ..
              </button>
            )}
            {result.dirs.map((dir) => (
              <button
                key={`dir:${dir}`}
                className="file-picker-item file-picker-dir"
                onClick={() => navigate(joinPath(result.path, dir))}
              >
                {dir}
              </button>
            ))}
            {files.map((file) => {
              const full = joinPath(result.path, file);
              return (
                <button
                  key={`file:${file}`}
                  className={`file-picker-item file-picker-file${selected === full ? " file-picker-item--selected" : ""}`}
                  onClick={() => setSelected(full)}
                  onDoubleClick={() => onSelect(full)}
                >
                  {file}
                </button>
              );
            })}
            {result.dirs.length === 0 && files.length === 0 && (
              <div className="file-picker-empty">
                {hiddenByFilter > 0 ? "no matching files" : "empty folder"}
              </div>
            )}
          </>
        )}
      </div>

      {result && hiddenByFilter > 0 && (
        <div className="file-picker-filternote">
          {hiddenByFilter} file{hiddenByFilter === 1 ? "" : "s"} hidden by filter
          {accept?.length ? ` (${accept.join(" ")})` : ""}
        </div>
      )}

      <button
        className="file-picker-select"
        onClick={() => selected && onSelect(selected)}
        disabled={!selected}
      >
        {selected ? `select ${folderLabel(selected)}` : "select a file"}
      </button>
    </div>
  );
}
