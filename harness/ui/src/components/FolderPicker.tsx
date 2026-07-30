/**
 * FolderPicker — server-side directory browser.
 *
 * Three modes:
 * - Browse: click folders to navigate the server filesystem
 * - Type: paste/type a path directly and hit enter
 * - Create: make a new folder in the current directory and descend into it
 *
 * Navigates the harness server's filesystem. Click folders to descend,
 * ".." to go up. "Select" picks the current directory as the cwd.
 */

import { useState, useEffect, useRef } from "react";
import { modus } from "../modusClient";
import { folderLabel, joinBrowsePath, validateFolderName } from "../folderPath";
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
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const newNameRef = useRef<HTMLInputElement>(null);

  const navigate = (path?: string) => {
    setLoading(true);
    setError(null);
    // Leaving the directory invalidates a half-typed name and the sibling list
    // it was being checked against.
    setCreating(false);
    setNewName("");
    setCreateError(null);
    modus.browse(path)
      .then((r) => {
        setResult(r);
        setPathInput(r.path);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  const beginCreate = () => {
    setCreating(true);
    setNewName("");
    setCreateError(null);
  };

  const cancelCreate = () => {
    setCreating(false);
    setNewName("");
    setCreateError(null);
  };

  const submitCreate = async () => {
    if (!result || createBusy) return;
    const check = validateFolderName(newName, result.dirs);
    if (!check.ok) {
      setCreateError(check.error);
      return;
    }
    const target = joinBrowsePath(result.path, check.name);
    setCreateBusy(true);
    setCreateError(null);
    try {
      const ok = await modus.createDirectory(target);
      if (!ok) {
        // createDirectory collapses every failure into false, so the reason
        // (permissions, read-only volume) is not recoverable here.
        setCreateError("could not create folder");
        return;
      }
      cancelCreate();
      navigate(target);
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const handleNewNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitCreate();
    }
    // Escape backs out of creating without closing the whole picker.
    if (e.key === "Escape") {
      e.stopPropagation();
      cancelCreate();
    }
  };

  useEffect(() => {
    if (creating) newNameRef.current?.focus();
  }, [creating]);

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
        <div className="folder-picker-create">
          {creating ? (
            <>
              <div className="folder-picker-create-row">
                <input
                  ref={newNameRef}
                  className="folder-picker-create-input"
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
                  onKeyDown={handleNewNameKeyDown}
                  spellCheck={false}
                  placeholder="folder name"
                  disabled={createBusy}
                />
                <button
                  className="folder-picker-create-confirm"
                  onClick={() => void submitCreate()}
                  disabled={createBusy || !newName.trim()}
                >
                  {createBusy ? "..." : "create"}
                </button>
                <button
                  className="folder-picker-create-cancel"
                  onClick={cancelCreate}
                  disabled={createBusy}
                >
                  &times;
                </button>
              </div>
              {createError && <div className="folder-picker-error">{createError}</div>}
            </>
          ) : (
            <button className="folder-picker-new" onClick={beginCreate}>
              + new folder
            </button>
          )}
        </div>
      )}

      {result && (
        <button
          className="folder-picker-select"
          onClick={() => onSelect(result.path)}
        >
          select {folderLabel(result.path)}
        </button>
      )}
    </div>
  );
}
