import { useEffect, useRef } from "react";
import { isTauriRuntime, hasPendingDesktopFiles, onDesktopFileOpen, takePendingDesktopFiles } from "../desktopBridge";
import { createDesktopFileInbox, watchRemoteDesktopFiles } from "../desktop-file-open";
import { nativePickerAvailable } from "../native-picker";
import { IS_MINI_VIEWER } from "../miniViewer";

const inbox = createDesktopFileInbox({ listen: onDesktopFileOpen, take: takePendingDesktopFiles });

export function useDesktopFileOpen(onFiles: (paths: string[]) => void, onRemote: () => void): void {
  const callbacks = useRef({ onFiles, onRemote });
  callbacks.current = { onFiles, onRemote };
  useEffect(() => {
    if (!isTauriRuntime() || IS_MINI_VIEWER) return;
    if (nativePickerAvailable()) return inbox.subscribe((paths) => callbacks.current.onFiles(paths));

    // Retain the Rust queue while connected to a remote machine. The local
    // backend can claim it after a target switch reloads the main webview.
    return watchRemoteDesktopFiles({ listen: onDesktopFileOpen, hasPending: hasPendingDesktopFiles }, () => callbacks.current.onRemote());
  }, []);
}
