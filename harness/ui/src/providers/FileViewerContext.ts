import { createContext, useContext } from "react";

type Tab = {
  path: string;
  pinned: boolean;
  editing: boolean;
  dirty: boolean;
  /** Loaded content for editing — null until first edit-mode load */
  content: string | null;
};

export type FileOpenRequest = {
  path: string;
  edit?: boolean;
  line?: number;
  endLine?: number;
  highlight?: boolean;
  source?: "file-change" | "tool-read" | "markdown" | "browser" | "ui-event" | "desktop";
};

type FileViewerContextValue = {
  tabs: Tab[];
  activePath: string | null;
  openFile: (path: string, opts?: Omit<FileOpenRequest, "path">) => void;
  closeFile: (path?: string) => void;
  pinFile: (path: string) => void;
  unpinFile: (path: string) => void;
  setActive: (path: string) => void;
  /** Toggle edit mode on/off for a tab */
  setEditing: (path: string, editing: boolean) => void;
  /** Mark a tab dirty (called by the editor on doc changes) */
  markDirty: (path: string) => void;
  /** Save a tab's content to disk */
  saveFile: (path: string, content: string) => Promise<boolean>;
  /** Restore saved state on session switch */
  hydrate: (tabs: Array<{ path: string; pinned: boolean; editing?: boolean; dirty?: boolean; content?: string | null }>, activePath: string | null) => void;
  /** Compat: single current path */
  path: string | null;
  /** Currently saving */
  saving: boolean;
  /** Last save error (auto-clears after 3s) */
  saveError: string | null;
  /** Increments when a viewed (non-editing) file changes on disk — triggers re-fetch */
  contentVersion: number;
  /** Subscribe to new file opens (excludes hydration restores). Returns unsubscribe fn. */
  subscribeFileOpens: (fn: (request: FileOpenRequest) => void) => () => void;
};

export type { Tab, FileViewerContextValue };

export const FileViewerContext = createContext<FileViewerContextValue>({
  tabs: [],
  activePath: null,
  openFile: () => {},
  closeFile: () => {},
  pinFile: () => {},
  unpinFile: () => {},
  setActive: () => {},
  setEditing: () => {},
  markDirty: () => {},
  saveFile: async () => false,
  hydrate: () => {},
  path: null,
  saving: false,
  saveError: null,
  contentVersion: 0,
  subscribeFileOpens: () => () => {},
});

export function useFileViewer() {
  return useContext(FileViewerContext);
}
