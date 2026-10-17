import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowsNativeContextMenu, installDesktopContextMenuGuard } from "../../ui/src/desktop-context-menu";

// Minimal element stand-ins: the guard only walks closest() and reads a few properties.
type FakeElement = {
  tag: string;
  type?: string;
  isContentEditable?: boolean;
  parent?: FakeElement;
  closest(selector: string): FakeElement | null;
};

function el(tag: string, props: { type?: string; isContentEditable?: boolean } = {}, parent?: FakeElement): FakeElement {
  const self: FakeElement = {
    tag,
    ...props,
    parent,
    closest(selector) {
      for (let cur: FakeElement | undefined = self; cur; cur = cur.parent) {
        if (cur.tag === selector) return cur;
      }
      return null;
    },
  };
  return self;
}

const target = (value: unknown) => value as EventTarget;
const selectionOf = (selected: FakeElement | null, collapsed = false) => ({
  isCollapsed: collapsed,
  containsNode: (node: unknown) => node === selected,
}) as unknown as Selection;

describe("allowsNativeContextMenu", () => {
  test("suppresses the page menu on ordinary content", () => {
    expect(allowsNativeContextMenu(target(el("div")), null)).toBe(false);
    expect(allowsNativeContextMenu(null, null)).toBe(false);
  });

  test("keeps the edit menu in text fields", () => {
    expect(allowsNativeContextMenu(target(el("textarea")), null)).toBe(true);
    expect(allowsNativeContextMenu(target(el("input", { type: "text" })), null)).toBe(true);
    expect(allowsNativeContextMenu(target(el("input", { type: "password" })), null)).toBe(true);
    expect(allowsNativeContextMenu(target(el("span", { isContentEditable: true })), null)).toBe(true);
  });

  test("a non-text input gets no browser menu", () => {
    expect(allowsNativeContextMenu(target(el("input", { type: "checkbox" })), null)).toBe(false);
    expect(allowsNativeContextMenu(target(el("input", { type: "range" })), null)).toBe(false);
  });

  test("keeps copy for a selection under the pointer only", () => {
    const span = el("span", {}, el("p"));
    expect(allowsNativeContextMenu(target(span), selectionOf(span))).toBe(true);
    expect(allowsNativeContextMenu(target(span), selectionOf(span, true))).toBe(false);
    expect(allowsNativeContextMenu(target(span), selectionOf(el("p")))).toBe(false);
  });

  test("resolves a text-node target to its parent element", () => {
    expect(allowsNativeContextMenu(target({ parentElement: el("textarea") }), null)).toBe(true);
    expect(allowsNativeContextMenu(target({ parentElement: el("div") }), null)).toBe(false);
  });
});

describe("installDesktopContextMenuGuard", () => {
  function fakeDocument() {
    let handler: ((event: MouseEvent) => void) | null = null;
    const doc = {
      addEventListener: (_type: string, fn: (event: MouseEvent) => void) => { handler = fn; },
      removeEventListener: (_type: string, fn: (event: MouseEvent) => void) => { if (handler === fn) handler = null; },
      getSelection: () => null,
    };
    const fire = (eventTarget: unknown, defaultPrevented = false) => {
      const preventDefault = mock(() => {});
      handler?.({ target: eventTarget, defaultPrevented, preventDefault } as unknown as MouseEvent);
      return preventDefault;
    };
    return { doc: doc as unknown as Document, fire, installed: () => handler !== null };
  }

  test("prevents the menu on content and leaves text fields alone", () => {
    const { doc, fire } = fakeDocument();
    installDesktopContextMenuGuard(doc);
    expect(fire(el("div"))).toHaveBeenCalledTimes(1);
    expect(fire(el("textarea"))).not.toHaveBeenCalled();
  });

  test("defers to a surface that already opened its own menu", () => {
    const { doc, fire } = fakeDocument();
    installDesktopContextMenuGuard(doc);
    expect(fire(el("div"), true)).not.toHaveBeenCalled();
  });

  test("uninstalls cleanly", () => {
    const { doc, installed } = fakeDocument();
    const uninstall = installDesktopContextMenuGuard(doc);
    expect(installed()).toBe(true);
    uninstall();
    expect(installed()).toBe(false);
  });

  // A browser tab keeps its browser menu; only the native desktop window installs the guard.
  test("the entry point installs it for the desktop runtime only", () => {
    const main = readFileSync(join(import.meta.dir, "..", "..", "ui", "src", "main.tsx"), "utf8");
    expect(main).toMatch(/if \(isTauriRuntime\(\)\) installDesktopContextMenuGuard\(\)/);
  });
});
