/**
 * FolderPicker — server-side directory browser.
 *
 * Two modes:
 * - Browse: click folders to navigate the server filesystem
 * - Type: paste/type a path directly and hit enter
 *
 * Navigates the harness server's filesystem. Click folders to descend,
 * ".." to go up. "Select" picks the current directory as the cwd.
 */

import { useState, useEffect } from "react";
import { modus } from "../modusClient";
import type { BrowseResult } from "../../../sdk/index";

type Props = {
  onSelect: (path: string) => void;
  onCancel: () => void;
  initialPath?: string;
};

export function FolderPicker({ onSelect, onCancel, initialPath }: Props) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pathInput, setPathInput] = useState(initialPath ?? "");

  const navigate = (path?: string) => {
    setLoading(true);
    setError(null);
    modus.browse(path)
      .then((r) => {
        setResult(r);
        setPathInput(r.path);
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

  return (
    <div className="folder-picker">
      <div className="folder-picker-header">
        <span className="folder-picker-title">select folder</span>
        <button className="folder-picker-close" onClick={onCancel}>&times;</button>
      </div>

      {/* Editable path bar — type to jump */}
      <div className="folder-picker-pathbar">
        <input
          className="folder-picker-input"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={handlePathKeyDown}
          onBlur={handlePathSubmit}
          spellCheck={false}
          placeholder="/path/to/folder"
        />
      </div>

      <div className="folder-picker-list">
        {loading && <div className="folder-picker-loading">loading...</div>}
        {error && <div className="folder-picker-error">{error}</div>}

        {!loading && result && (
          <>
            {result.parent && (
              <button
                className="folder-picker-item folder-picker-parent"
                onClick={() => navigate(result.parent!)}
              >
                ..
              </button>
            )}
            {result.dirs.map((dir) => (
              <button
                key={dir}
                className="folder-picker-item"
                onClick={() => navigate(`${result.path}/${dir}`)}
              >
                {dir}
              </button>
            ))}
            {result.dirs.length === 0 && (
              <div className="folder-picker-empty">no subdirectories</div>
            )}
          </>
        )}
      </div>

      {result && (
        <button
          className="folder-picker-select"
          onClick={() => onSelect(result.path)}
        >
          select {result.path.split("/").pop() || "/"}
        </button>
      )}
    </div>
  );
}
