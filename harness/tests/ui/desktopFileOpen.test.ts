import { describe, expect, test } from "bun:test";
import { createDesktopFileInbox, isDesktopTextFile, isMarkdownFile, layoutHasFileEditor, watchRemoteDesktopFiles } from "../../ui/src/desktop-file-open";
import { projectForFile } from "../../ui/src/file-project";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("desktop file delivery", () => {
  test("remote targets report cold and live opens without claiming files", async () => {
    let notify!: () => void;
    let notices = 0;
    let claims = 0;
    let disposed = false;
    const bridge = {
      listen: async (handler: () => void) => { notify = handler; return () => { disposed = true; }; },
      hasPending: async () => true,
      take: async () => { claims++; return ["/tmp/local.md"]; },
    };
    const cleanup = watchRemoteDesktopFiles(bridge, () => { notices++; });
    await tick();
    expect(notices).toBe(1);
    notify();
    expect(notices).toBe(2);
    expect(claims).toBe(0);
    cleanup();
    notify();
    expect(notices).toBe(2);
    expect(disposed).toBe(true);
  });
  test("subscribes before claiming startup files and survives a StrictMode remount", async () => {
    const calls: string[] = [];
    let resolveTake!: (paths: string[]) => void;
    const inbox = createDesktopFileInbox({
      listen: async () => { calls.push("listen"); return () => {}; },
      take: () => { calls.push("take"); return new Promise((resolve) => { resolveTake = resolve; }); },
    });
    const first: string[][] = [];
    const second: string[][] = [];
    const cleanup = inbox.subscribe((paths) => first.push(paths));
    await tick();
    cleanup();
    resolveTake(["/tmp/startup.md"]);
    await tick();
    inbox.subscribe((paths) => second.push(paths));
    expect(calls).toEqual(["listen", "take"]);
    expect(first).toEqual([]);
    expect(second).toEqual([["/tmp/startup.md"]]);
  });

  test("an event during a claim drains the next batch without duplicates", async () => {
    let notify!: () => void;
    let resolveTake!: (paths: string[]) => void;
    let claims = 0;
    const received: string[][] = [];
    const inbox = createDesktopFileInbox({
      listen: async (handler) => { notify = handler; return () => {}; },
      take: () => ++claims === 1
        ? new Promise((resolve) => { resolveTake = resolve; })
        : Promise.resolve(["/tmp/second.markdown"]),
    });
    inbox.subscribe((paths) => received.push(paths));
    await tick();
    notify();
    resolveTake(["/tmp/first.md", "javascript:alert(1)", "relative.md", "/tmp/program.exe"]);
    await tick();
    expect(received).toEqual([["/tmp/first.md"], ["/tmp/second.markdown"]]);
    expect(claims).toBe(2);
  });

  test("recognizes Markdown extensions and refuses non-file payloads", () => {
    for (const path of ["C:\\Work\\notes.MD", "\\\\server\\share\\guide.markdown", "/tmp/plain.txt"]) expect(isDesktopTextFile(path)).toBe(true);
    for (const path of [null, {}, "C:notes.md", "notes.md", "/tmp/program.exe", `/tmp/a${String.fromCharCode(0)}.md`]) expect(isDesktopTextFile(path)).toBe(false);
    expect(isMarkdownFile("/tmp/guide.MARKDOWN")).toBe(true);
    expect(isMarkdownFile("/tmp/component.mdx")).toBe(true);
    expect(isMarkdownFile("/tmp/plain.txt")).toBe(false);
  });

  test("finds an editor inside nested page layouts without assuming empty targets can open files", () => {
    expect(layoutHasFileEditor({ kind: "scope", children: [{ kind: "tabs", children: [{ kind: "widget", widget: { type: "code-editor" } }] }] })).toBe(true);
    expect(layoutHasFileEditor({ kind: "tabs", editable: true, target: true, children: [] })).toBe(false);
    expect(layoutHasFileEditor({ kind: "widget", widget: { type: "docs" } })).toBe(false);
  });
});

describe("file project recognition", () => {
  const projects = [
    { name: "root", displayName: "Root", projects: ["C:/Work"] },
    { name: "nested", displayName: "Nested", projects: ["C:/Work/app/"] },
  ];
  test("chooses the deepest root across Windows casing and separators", () => {
    expect(projectForFile("c:\\work\\APP\\docs\\notes.md", projects)?.name).toBe("nested");
    expect(projectForFile("C:/Work/readme.md", projects)?.name).toBe("root");
    expect(projectForFile("C:/Workspace/readme.md", projects)).toBeUndefined();
    expect(projectForFile("D:/outside/readme.md", projects)).toBeUndefined();
  });
  test("preserves POSIX case and handles filesystem roots and UNC shares", () => {
    expect(projectForFile("/Work/readme.md", [{ name: "p", displayName: "p", projects: ["/work"] }])).toBeUndefined();
    expect(projectForFile("/notes.md", [{ name: "p", displayName: "p", projects: ["/"] }])?.name).toBe("p");
    expect(projectForFile("\\\\SERVER\\share\\notes.md", [{ name: "p", displayName: "p", projects: ["//server/share/"] }])?.name).toBe("p");
  });
});
