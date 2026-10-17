/**
 * Desktop context-menu guard.
 *
 * The desktop WebView's own right-click menu is a browser menu — Back, Refresh,
 * Save as, Print. Back and Refresh navigate the app window itself, and nothing in
 * the window offers a way back. The guard suppresses that menu everywhere it does
 * no real work, and keeps it where it does: editable text (cut, copy, paste,
 * spelling) and selected text under the pointer (copy). Surfaces with their own
 * menu already call preventDefault, so they are unaffected.
 *
 * Installed for the native desktop only; a browser tab keeps its browser menu.
 */

/** Input types whose native menu edits text. A checkbox's menu is the page menu. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "password", "tel", "number"]);

function elementOf(target: EventTarget | null): Element | null {
  if (!target) return null;
  if (typeof (target as Element).closest === "function") return target as Element;
  // A text node has no closest(); its parent element does.
  return (target as Node).parentElement ?? null;
}

/** Whether the native menu still does useful work for this right-click. */
export function allowsNativeContextMenu(target: EventTarget | null, selection: Selection | null): boolean {
  const el = elementOf(target);
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.closest("textarea")) return true;
  const input = el.closest("input") as HTMLInputElement | null;
  if (input && TEXT_INPUT_TYPES.has(input.type)) return true;
  return !!selection && !selection.isCollapsed && selection.containsNode(el, true);
}

/** Suppress the WebView menu for this document. Returns the uninstaller. */
export function installDesktopContextMenuGuard(doc: Document = document): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (allowsNativeContextMenu(event.target, doc.getSelection())) return;
    event.preventDefault();
  };
  doc.addEventListener("contextmenu", onContextMenu);
  return () => doc.removeEventListener("contextmenu", onContextMenu);
}
