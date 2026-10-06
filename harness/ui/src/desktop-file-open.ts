import { normalizeLocalFilePath } from "./local-file-path";

export function isDesktopTextFile(path: unknown): path is string {
  return typeof path === "string" && !path.includes(String.fromCharCode(0))
    && /^(?:[A-Za-z]:[/\\]|\\\\|\/)/.test(path)
    && /\.(?:md|markdown|txt)$/i.test(path);
}

export function isMarkdownFile(path: string): boolean {
  return /\.(?:md|mdx|markdown)$/i.test(path);
}

export function layoutHasFileEditor(layout: unknown): boolean {
  if (!layout || typeof layout !== "object") return false;
  const node = layout as { widget?: { type?: string }; children?: unknown[] };
  return node.widget?.type === "code-editor"
    || (Array.isArray(node.children) && node.children.some(layoutHasFileEditor));
}

type FileOpenBridge = {
  listen: (notify: () => void) => Promise<() => void>;
  take: () => Promise<string[]>;
};

/** A remote target may learn that files are waiting, but never claims paths. */
export function watchRemoteDesktopFiles(bridge: {
  listen: FileOpenBridge["listen"];
  hasPending: () => Promise<boolean>;
}, notify: () => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void bridge.listen(() => { if (!disposed) notify(); }).then((dispose) => {
    if (disposed) dispose();
    else unlisten = dispose;
    return bridge.hasPending();
  }).then((pending) => {
    if (!disposed && pending) notify();
  }).catch(() => {});
  return () => { disposed = true; unlisten?.(); };
}

/** Subscribe before claiming the OS queue. Keep claimed files in memory until
 * React has a consumer, including across StrictMode's mount/cleanup/remount. */
export function createDesktopFileInbox(bridge: FileOpenBridge) {
  let started = false;
  let draining = false;
  let requested = false;
  let buffered: string[] = [];
  let consumer: ((paths: string[]) => void) | undefined;

  const flush = () => {
    if (!consumer || !buffered.length) return;
    const paths = buffered;
    buffered = [];
    consumer(paths);
  };
  const drain = async () => {
    requested = true;
    if (draining) return;
    draining = true;
    try {
      while (requested) {
        requested = false;
        const paths = await bridge.take();
        buffered.push(...paths.filter(isDesktopTextFile).map(normalizeLocalFilePath));
        flush();
      }
    } catch {
      // Older desktop shells do not expose the file-open command.
    } finally {
      draining = false;
    }
  };
  return {
    subscribe(handler: (paths: string[]) => void) {
      consumer = handler;
      flush();
      if (!started) {
        started = true;
        void bridge.listen(() => { void drain(); })
          .then(() => drain())
          .catch(() => {});
      }
      return () => { if (consumer === handler) consumer = undefined; };
    },
  };
}
