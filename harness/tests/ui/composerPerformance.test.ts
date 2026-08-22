import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI_ROOT = join(import.meta.dir, "..", "..", "ui", "src");

describe("composer keystroke isolation", () => {
  it("subscribes to drafts below the config bar", () => {
    const source = readFileSync(join(UI_ROOT, "widgets", "composer.widget.tsx"), "utf8");
    const widgetBody = source.slice(source.indexOf("export default function ComposerWidget"));

    expect(source).toContain("const ComposerInput = memo(function ComposerInput(props: ComposerInputProps)");
    expect(source).toContain("const input = useInputValue();");
    expect(widgetBody).not.toContain("const input = useInputValue();");
    expect(widgetBody).toContain("<ComposerInput");
  });

  it("keeps draft subscriptions out of full session-list surfaces", () => {
    const sidebar = readFileSync(join(UI_ROOT, "components", "Sidebar.tsx"), "utf8");
    const widget = readFileSync(join(UI_ROOT, "widgets", "session-list.widget.tsx"), "utf8");
    const list = readFileSync(join(UI_ROOT, "components", "sidebar", "SessionList.tsx"), "utf8");

    expect(sidebar).not.toContain("useInputValue");
    expect(widget).not.toContain("useInputValue");
    expect(list).toContain("function ActiveSessionItem");
  });

  it("retains inactive pages without leaving their effects live", () => {
    const app = readFileSync(join(UI_ROOT, "App.tsx"), "utf8");

    expect(app).toContain("<Activity key={page.id}");
    expect(app).toContain('mode={isActive ? "visible" : "hidden"}');
    expect(app).not.toContain('style={{ display: isActive ? "contents" : "none" }}');
  });

  it("coalesces transcript measurements and keeps session objects stable", () => {
    const virtualList = readFileSync(join(UI_ROOT, "components", "VirtualMessageList.tsx"), "utf8");
    const sessionListWidget = readFileSync(join(UI_ROOT, "widgets", "session-list.widget.tsx"), "utf8");

    expect(virtualList).toContain("measurementFrameRef");
    expect(virtualList).toContain("scheduleMeasurementRender");
    expect(sessionListWidget).toContain("sessions={serverSessions}");
    expect(sessionListWidget).not.toContain("serverSessions.map");
  });

  it("keeps streamed transcript revisions out of shell navigation contexts", () => {
    const app = readFileSync(join(UI_ROOT, "App.tsx"), "utf8");
    const layout = readFileSync(join(UI_ROOT, "providers", "LayoutProvider.tsx"), "utf8");
    const provider = readFileSync(join(UI_ROOT, "providers", "SessionProvider.tsx"), "utf8");
    const sessionConsumers = [
      join(UI_ROOT, "components"),
      join(UI_ROOT, "widgets"),
    ];

    expect(app).not.toContain('import { useSession } from "./providers/SessionContext"');
    expect(app).toContain("useActiveSessionId()");
    expect(layout).toContain("useActiveSessionId()");
    expect(layout).not.toContain("useSession()");
    expect(provider).toContain("const stableActions = useMemo<SessionActionsContextValue>");
    for (const directory of sessionConsumers) {
      const sources = new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: directory, absolute: true });
      for (const path of sources) {
        expect(readFileSync(path, "utf8")).not.toContain("useSession()");
      }
    }
  });

  it("deactivates panel widget trees while their panels are closed", () => {
    const left = readFileSync(join(UI_ROOT, "components", "LeftPanel.tsx"), "utf8");
    const right = readFileSync(join(UI_ROOT, "components", "RightPanel.tsx"), "utf8");
    const surface = readFileSync(join(UI_ROOT, "components", "PanelSurface.tsx"), "utf8");

    expect(left).toContain('<Activity mode={open ? "visible" : "hidden"} name="left-panel">');
    expect(right).toContain('<Activity mode={open ? "visible" : "hidden"} name="right-panel">');
    expect(surface).toContain('<Activity key={item.id} mode={active ? "visible" : "hidden"}');
  });

  it("does not repeatedly restart transcript materialization", () => {
    const conversation = readFileSync(join(UI_ROOT, "widgets", "session-chat.widget.tsx"), "utf8");
    const turns = readFileSync(join(UI_ROOT, "widgets", "session-turn.widget.tsx"), "utf8");

    expect(conversation).not.toContain("useDeferredValue");
    expect(conversation).toContain("const messages = session?.messages ?? EMPTY_MESSAGES;");
    expect(turns).not.toContain("useDeferredValue");
    expect(turns).toContain("const messages = session?.messages ?? EMPTY_TURN_MESSAGES;");
  });

  it("measures textarea height once per controlled value update", () => {
    const source = readFileSync(join(UI_ROOT, "components", "ChatInput.tsx"), "utf8");

    expect(source).toContain("useLayoutEffect(() => {");
    expect(source).not.toContain("onInput={(e) => {");
  });
});
