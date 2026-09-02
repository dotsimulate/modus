/**
 * DirectoryViewer — renders a directory listing with navigation.
 *
 * Shows directory name, subdirectory count, parent navigation (..), and
 * clickable entries. Used by RightPanel when viewing a directory path.
 */

import type { ReactNode } from "react";

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

type Props = {
  path: string;
  dirs: string[];
  parent: string | null;
  onNavigate: (path: string) => void;
  nameActions?: ReactNode;
  actions?: ReactNode;
};

export function DirectoryViewer({ path, dirs, parent, onNavigate, nameActions, actions }: Props) {
  const entries = dirs.map((dir) => ({
    key: `dir:${dir}`,
    name: dir,
    path: `${path}/${dir}`,
  }));

  return (
    <div className="fcv-panel right-panel-file">
      <div className="fcv-head">
        <div className="fcv-meta">
          <div className="fcv-name-row">
            {nameActions && <div className="fcv-name-actions">{nameActions}</div>}
            <span className="fcv-name">{basename(path) || "/"}</span>
          </div>
        </div>
        <div className="fcv-head-side">
          <span className="fcv-count">{entries.length} folder{entries.length === 1 ? "" : "s"}</span>
          {actions && <div className="fcv-actions">{actions}</div>}
        </div>
      </div>
      <div className="fcv-body">
        <div className="fcv-directory">
          <div className="fcv-directory-path">{path}</div>
          <div className="fcv-directory-list">
            {parent && (
              <button className="fcv-directory-entry fcv-directory-entry--parent" onClick={() => onNavigate(parent)}>
                ..
              </button>
            )}
            {entries.length === 0 && <div className="fcv-state">No subfolders.</div>}
            {entries.map((entry) => (
              <button key={entry.key} className="fcv-directory-entry" onClick={() => onNavigate(entry.path)}>
                <span className="fcv-directory-dot" aria-hidden="true" />
                <span className="fcv-directory-name">{entry.name}</span>
                <span className="fcv-directory-type">dir</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
