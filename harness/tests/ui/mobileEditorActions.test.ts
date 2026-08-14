import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI = join(resolveTestSourceDir(import.meta.dir, "..", "..", "ui"), "src");
const component = (name: string) => readFileSync(join(UI, "components", name), "utf8");
const style = (name: string) => readFileSync(join(UI, "styles", name), "utf8");

describe("code editor touch actions", () => {
  test("the visible Save action saves the live CodeMirror document", () => {
    const editor = component("CodeMirrorEditor.tsx");
    const workspace = component("CodeWorkspacePanel.tsx");

    expect(editor).toContain("CodeMirrorEditorHandle");
    expect(editor).toContain("onSaveRef.current(view.state.doc.toString())");
    expect(workspace).toContain("ref={editorRef}");
    expect(workspace).toContain('aria-label="Save file"');
    expect(workspace).toContain("editorRef.current?.save()");
    expect(workspace).toContain("disabled={!activeTab?.dirty || saving}");
    expect(workspace).toContain('<span className="cw-mobile-action-label">Save</span>');
    expect(workspace).toContain('{isEditMode ? "View" : "Edit"}');
  });

  test("creation and contextual commands have explicit element triggers", () => {
    const workspace = component("CodeWorkspacePanel.tsx");
    const browser = component("FileBrowser.tsx");

    expect(workspace).toContain('aria-label="New file or folder"');
    expect(workspace).toContain("(showBrowser || sidebarOpen)");
    expect(workspace).toContain('<span className="cw-mobile-action-label">New</span>');
    expect(workspace).toContain('aria-label="File actions"');
    expect(workspace).toContain('label: "Close others"');
    expect(workspace).toContain('label: "Close all"');
    expect(workspace).toContain("tabCtxMenu.openFromElement");

    expect(browser).toContain("startCreate:");
    expect(browser).toContain('label: "New file..."');
    expect(browser).toContain('label: "New folder..."');
    expect(browser).toContain("ctxMenu.openFromElement");
    expect(browser.match(/className="fb-entry-more"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("the generic menu is a tap-safe sheet on touch clients", () => {
    const menu = component("ContextMenu.tsx");
    const css = style("components/context-menu.css");

    expect(menu).toContain('className="ctx-menu-backdrop"');
    expect(menu).toContain('className="ctx-menu ctx-menu--root"');
    expect(menu).toContain("openFromElement");
    expect(menu).toContain("onClick={handleToggle}");
    expect(menu).toContain("aria-expanded={expanded}");
    expect(css).toContain("(hover: none) and (pointer: coarse)");
    expect(css).toContain(".ctx-menu--root");
    expect(css).toContain("bottom: max(8px, env(safe-area-inset-bottom))");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain(".ctx-menu-submenu.ctx-menu-submenu--open");
  });

  test("tab and tree actions do not depend on hover for touch clients", () => {
    const mobile = style("mobile.css");
    const browser = style("components/file-browser.css");

    expect(mobile).toMatch(/\.cw-tab-close\s*\{[\s\S]*?opacity:\s*0\.72/);
    expect(browser).toContain(".fb-entry-more");
    expect(browser).toContain("min-width: 44px");
    expect(browser).toContain("opacity: 1");
    expect(browser).toContain("border-left: 1px solid var(--border)");
  });
});
