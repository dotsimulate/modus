import { lazyView } from "../lazy-view";

export type { CodeMirrorContextInfo, CodeMirrorEditorHandle } from "./CodeMirrorEditor";

export const TerminalView = lazyView(async () => ({ default: (await import("./TerminalView")).TerminalView }));
export const CodeMirrorEditor = lazyView(async () => ({ default: (await import("./CodeMirrorEditor")).CodeMirrorEditor }));
export const CodeMirrorViewer = lazyView(async () => ({ default: (await import("./CodeMirrorViewer")).CodeMirrorViewer }));
