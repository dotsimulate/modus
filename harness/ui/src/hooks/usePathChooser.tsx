/**
 * One entry point for "let the user choose a path", native where it is correct.
 *
 * Every call site used to hold a boolean and render `<FolderPicker>` inline,
 * which hardcoded the server-side browser as the only picker. The choice
 * between that and the OS dialog belongs in one place — see `native-picker.ts`
 * for why it is a choice at all — so these hooks own it and callers just say
 * `open()` and render `inline`.
 *
 * `inline` is null whenever the native dialog handled it, so a caller's wrapper
 * element should be conditional on the node, not on having called `open`.
 */

import { useCallback, useState, type ReactNode } from "react";
import { FolderPicker } from "../components/FolderPicker";
import { FilePicker } from "../components/FilePicker";
import { pickDesktopFile, pickDesktopFolder } from "../desktopBridge";
import { canonicalFile, canonicalFolder, nativePickerAvailable } from "../native-picker";
import { parentDir } from "../folderPath";

type ChooseRequest = {
  /** Directory to open in — a directory in both hooks, never the file being replaced. */
  initialPath?: string;
  title?: string;
  onSelect: (path: string) => void;
};

type FileChooseRequest = ChooseRequest & {
  /** Extension allowlist, e.g. [".png", ".jpg"]. Empty shows every file. */
  accept?: string[];
};

export type PathChooser<R extends ChooseRequest = ChooseRequest> = {
  /** Opens the OS dialog, or stages the in-app browser for `inline` to render. */
  open: (request: R) => void;
  close: () => void;
  /** The in-app browser, or null when the native dialog is handling this. */
  inline: ReactNode;
  /** True while the native dialog is up — it blocks until the user answers. */
  busy: boolean;
};

export function useFolderChooser(): PathChooser {
  const [request, setRequest] = useState<ChooseRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback((next: ChooseRequest) => {
    if (!nativePickerAvailable()) {
      setRequest(next);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const picked = await pickDesktopFolder({ title: next.title, initialPath: next.initialPath });
        if (picked === null) return;
        const canonical = await canonicalFolder(picked);
        if (canonical === null) {
          // The backend cannot open what the OS handed us. Storing it would fail
          // later and elsewhere, so hand over the browser that speaks the
          // server's filesystem, opened as close to the choice as it can get.
          setRequest({ ...next, initialPath: picked });
          return;
        }
        next.onSelect(canonical);
      } catch {
        // The bridge is gone or the dialog failed; the in-app browser still works.
        setRequest(next);
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const close = useCallback(() => setRequest(null), []);

  const inline = request ? (
    <FolderPicker
      initialPath={request.initialPath}
      onSelect={(path) => {
        setRequest(null);
        request.onSelect(path);
      }}
      onCancel={close}
    />
  ) : null;

  return { open, close, inline, busy };
}

export function useFileChooser(): PathChooser<FileChooseRequest> {
  const [request, setRequest] = useState<FileChooseRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback((next: FileChooseRequest) => {
    if (!nativePickerAvailable()) {
      setRequest(next);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const picked = await pickDesktopFile({
          title: next.title,
          initialPath: next.initialPath,
          accept: next.accept,
        });
        if (picked === null) return;
        const canonical = await canonicalFile(picked);
        if (canonical === null) {
          // Hand over the in-app browser pointed at the chosen file's folder,
          // which is the closest the server-side listing can get to the pick.
          setRequest({ ...next, initialPath: parentDir(picked) || next.initialPath });
          return;
        }
        next.onSelect(canonical);
      } catch {
        setRequest(next);
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const close = useCallback(() => setRequest(null), []);

  const inline = request ? (
    <FilePicker
      initialPath={request.initialPath}
      accept={request.accept}
      title={request.title}
      onSelect={(path) => {
        setRequest(null);
        request.onSelect(path);
      }}
      onCancel={close}
    />
  ) : null;

  return { open, close, inline, busy };
}
