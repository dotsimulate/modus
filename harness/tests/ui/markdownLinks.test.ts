import { describe, expect, it } from "bun:test";
import {
  buildLinkMenuItems,
  classifyLinkTarget,
  fileManagerName,
  isAbsolutePath,
  markdownUrlTransform,
  resolveMarkdownLinkTarget,
  splitLocalPath,
  type LinkMenuActions,
  type LinkMenuCapabilities,
} from "../../ui/src/markdown-links";

describe("classifyLinkTarget", () => {
  it("routes session aliases before classifying filesystem paths", () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    for (const prefix of ["modus://session/", "modus:session/", "/session/", "//session/"]) {
      expect(resolveMarkdownLinkTarget(`${prefix}${id}`, "/repo/docs/guide.md")).toEqual({
        kind: "navigation", target: { kind: "session", sessionId: id },
      });
    }
    expect(classifyLinkTarget("modus://page/project/board")).toEqual({
      kind: "navigation", target: { kind: "page", project: "project", slug: "board" },
    });
    for (const href of ["modus://move/run", "modus://session/invalid", `modus://session/${id}/extra`, "modus://page/project/../board"]) {
      expect(classifyLinkTarget(href)).toEqual({ kind: "unsupported" });
    }
  });

  it("decodes Markdown file destinations without losing line numbers", () => {
    expect(resolveMarkdownLinkTarget("My%20Report.md:12", "/repo/README.md")).toMatchObject({
      kind: "local", path: "/repo/My Report.md", line: 12,
    });
    expect(classifyLinkTarget("/repo/100%.md")).toMatchObject({ path: "/repo/100%.md" });
  });
  it("treats a Windows drive path as a file, not as a scheme", () => {
    // `C:` matches the scheme grammar, which is why the drive test runs first.
    expect(classifyLinkTarget("C:\\Users\\dot\\notes.md")).toMatchObject({
      kind: "local",
      path: "C:\\Users\\dot\\notes.md",
      absolute: true,
    });
    expect(classifyLinkTarget("D:/Work/app/harness/index.ts")).toMatchObject({
      kind: "local",
      absolute: true,
    });
  });

  it("accepts UNC and POSIX absolute paths", () => {
    expect(classifyLinkTarget("\\\\server\\share\\build.log")).toMatchObject({
      kind: "local",
      absolute: true,
    });
    expect(classifyLinkTarget("/home/dot/project/main.rs")).toMatchObject({
      kind: "local",
      absolute: true,
    });
  });

  it("marks relative and home-relative paths as not absolute", () => {
    expect(classifyLinkTarget("src/components/Markdown.tsx")).toMatchObject({
      kind: "local",
      absolute: false,
    });
    expect(classifyLinkTarget("~/notes/todo.md")).toMatchObject({ kind: "local", absolute: false });
    expect(classifyLinkTarget("./scripts/build.sh")).toMatchObject({ kind: "local", absolute: false });
    expect(classifyLinkTarget("../sibling/file.txt")).toMatchObject({ kind: "local", absolute: false });
  });

  it("keeps spaces and non-ASCII in the path", () => {
    expect(classifyLinkTarget("C:\\Users\\dot\\My Documents\\résumé.pdf")).toMatchObject({
      kind: "local",
      path: "C:\\Users\\dot\\My Documents\\résumé.pdf",
    });
  });

  it("classifies http and https as web and preserves the authored url", () => {
    expect(classifyLinkTarget("https://example.com/a?b=1")).toEqual({
      kind: "web",
      url: "https://example.com/a?b=1",
    });
    expect(classifyLinkTarget("http://127.0.0.1:4200/health")).toEqual({
      kind: "web",
      url: "http://127.0.0.1:4200/health",
    });
  });

  it("recognizes bare hosts that would otherwise read as filenames", () => {
    // `127.0.0.1` ends in `.1`, which the old extension heuristic called a file.
    expect(classifyLinkTarget("127.0.0.1:4200")).toEqual({ kind: "web", url: "http://127.0.0.1:4200" });
    expect(classifyLinkTarget("localhost:5180/chat")).toEqual({
      kind: "web",
      url: "http://localhost:5180/chat",
    });
    expect(classifyLinkTarget("www.example.com/docs")).toEqual({
      kind: "web",
      url: "https://www.example.com/docs",
    });
    expect(classifyLinkTarget("[::1]:4200")).toEqual({ kind: "web", url: "http://[::1]:4200" });
  });

  it("refuses every scheme outside the allowlist", () => {
    for (const href of [
      "mailto:dot@example.com",
      "tel:+15550100",
      "file:///C:/Windows/System32/cmd.exe",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "modus://session/abc",
      "vscode://file/C:/x",
    ]) {
      expect(classifyLinkTarget(href)).toEqual({ kind: "unsupported" });
    }
  });

  it("refuses empty, whitespace-only, and in-page anchors", () => {
    expect(classifyLinkTarget("")).toEqual({ kind: "unsupported" });
    expect(classifyLinkTarget("   ")).toEqual({ kind: "unsupported" });
    expect(classifyLinkTarget("#section-two")).toEqual({ kind: "unsupported" });
    expect(classifyLinkTarget("plainword")).toEqual({ kind: "unsupported" });
  });
});

describe("markdownUrlTransform", () => {
  it("preserves Windows hrefs that react-markdown otherwise erases", () => {
    expect(markdownUrlTransform("D:/Work/app/README.md", "href")).toBe(
      "D:/Work/app/README.md",
    );
    expect(markdownUrlTransform("C:\\src\\main.ts", "href")).toBe("C:\\src\\main.ts");
  });

  it("preserves Windows images for ticketed rendering but rejects unsupported schemes", () => {
    expect(markdownUrlTransform("javascript:alert(1)", "href")).toBe("");
    expect(markdownUrlTransform("D:/example/image.png", "src")).toBe("D:/example/image.png");
    expect(markdownUrlTransform("javascript:alert(1)", "src")).toBe("");
  });

  it("leaves ordinary web and relative links unchanged", () => {
    expect(markdownUrlTransform("https://example.com/docs", "href")).toBe("https://example.com/docs");
    expect(markdownUrlTransform("docs/guide.md", "href")).toBe("docs/guide.md");
  });
});

describe("Markdown file-relative links", () => {
  it("resolves bare and dot-relative links beside the displayed Windows file", () => {
    expect(resolveMarkdownLinkTarget("SUPPORT.md", "D:/Work/app/README.md")).toMatchObject({
      kind: "local",
      path: "D:/Work/app/SUPPORT.md",
      absolute: true,
    });
    expect(resolveMarkdownLinkTarget("./moves.md", "D:\\Work\\app\\harness\\docs\\pages.md")).toMatchObject({
      path: "D:/Work/app/harness/docs/moves.md",
    });
  });

  it("normalizes parent traversal for absolute and checkout-relative source files", () => {
    expect(resolveMarkdownLinkTarget("../README.md", "/srv/modus/docs/guide.md")).toMatchObject({
      path: "/srv/modus/README.md",
      absolute: true,
    });
    expect(resolveMarkdownLinkTarget("../README.md", "harness/docs/guide.md")).toMatchObject({
      path: "harness/README.md",
      absolute: false,
    });
  });

  it("does not rewrite absolute, home-relative, or web targets", () => {
    expect(resolveMarkdownLinkTarget("C:/other/file.md", "D:/repo/README.md")).toMatchObject({
      path: "C:/other/file.md",
    });
    expect(resolveMarkdownLinkTarget("~/notes.md", "D:/repo/README.md")).toMatchObject({
      path: "~/notes.md",
    });
    expect(resolveMarkdownLinkTarget("https://example.com", "D:/repo/README.md")).toEqual({
      kind: "web",
      url: "https://example.com",
    });
  });
});

describe("line references", () => {
  it("parses the GitHub fragment forms", () => {
    expect(classifyLinkTarget("src/main.rs#L12")).toMatchObject({ path: "src/main.rs", line: 12 });
    expect(classifyLinkTarget("src/main.rs#L12-L18")).toMatchObject({ line: 12, endLine: 18 });
    expect(classifyLinkTarget("src/main.rs#L12-18")).toMatchObject({ line: 12, endLine: 18 });
  });

  it("parses the trailing-colon form Modus and models actually emit", () => {
    expect(classifyLinkTarget("harness/index.ts:406")).toMatchObject({
      kind: "local",
      path: "harness/index.ts",
      line: 406,
    });
    // A column may follow; only the line is used.
    expect(classifyLinkTarget("harness/index.ts:406:12")).toMatchObject({
      path: "harness/index.ts",
      line: 406,
    });
  });

  it("does not mistake a Windows drive letter for a line number", () => {
    expect(splitLocalPath("C:\\src\\main.rs")).toEqual({ path: "C:\\src\\main.rs" });
    expect(splitLocalPath("C:\\src\\main.rs:88")).toMatchObject({ path: "C:\\src\\main.rs", line: 88 });
  });

  it("does not read a url port as a line number", () => {
    // The trailing-colon rule must never reach the web branch.
    expect(classifyLinkTarget("http://localhost:5180")).toEqual({
      kind: "web",
      url: "http://localhost:5180",
    });
  });

  it("drops a fragment that is not a line reference", () => {
    expect(splitLocalPath("docs/guide.md#installation")).toEqual({ path: "docs/guide.md" });
  });
});

describe("isAbsolutePath", () => {
  it("recognizes all three absolute forms and rejects the rest", () => {
    expect(isAbsolutePath("C:/x")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("/usr/local")).toBe(true);
    expect(isAbsolutePath("x/y")).toBe(false);
    expect(isAbsolutePath("~/x")).toBe(false);
    expect(isAbsolutePath("C:")).toBe(false);
  });
});

describe("fileManagerName", () => {
  it("names the platform's own file manager", () => {
    expect(fileManagerName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("File Explorer");
    expect(fileManagerName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Finder");
    expect(fileManagerName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("file manager");
  });
});

function recordingActions() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record = (op: string) => (...args: unknown[]) => { calls.push({ op, args }); };
  const actions: LinkMenuActions = {
    openInEditor: record("openInEditor"),
    revealPath: record("revealPath"),
    openPath: record("openPath"),
    openExternal: record("openExternal"),
    copy: record("copy"),
  };
  return { calls, actions };
}

const DESKTOP: LinkMenuCapabilities = {
  nativeFileActions: true,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
};
const BROWSER: LinkMenuCapabilities = {
  nativeFileActions: false,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
};

function labels(items: ReturnType<typeof buildLinkMenuItems>): string[] {
  return items.flatMap((item) => (item.kind === "action" ? [item.label] : []));
}

function click(items: ReturnType<typeof buildLinkMenuItems>, label: string) {
  const item = items.find((entry) => entry.kind === "action" && entry.label === label);
  if (!item || item.kind !== "action") throw new Error(`no menu item labelled ${label}`);
  item.onClick();
}

describe("buildLinkMenuItems", () => {
  it("offers OS actions for an absolute path on a local desktop client", () => {
    const { actions } = recordingActions();
    const items = buildLinkMenuItems(classifyLinkTarget("C:\\build\\app.exe"), DESKTOP, actions);
    expect(labels(items)).toEqual([
      "Open in editor",
      "Reveal in File Explorer",
      "Open with default app",
      "Copy path",
    ]);
  });

  it("hides OS actions in a browser, keeping the in-app ones", () => {
    const { actions } = recordingActions();
    const items = buildLinkMenuItems(classifyLinkTarget("C:\\build\\app.exe"), BROWSER, actions);
    expect(labels(items)).toEqual(["Open in editor", "Copy path"]);
  });

  it("hides OS actions for a relative path even on the desktop", () => {
    // Relative resolves against the desktop process's directory, not the project.
    const { actions } = recordingActions();
    const items = buildLinkMenuItems(classifyLinkTarget("src/main.rs"), DESKTOP, actions);
    expect(labels(items)).toEqual(["Open in editor", "Copy path"]);
  });

  it("copies the authored path, never a resolved url, and without the line suffix", () => {
    const { calls, actions } = recordingActions();
    const items = buildLinkMenuItems(classifyLinkTarget("/srv/app/main.rs:88"), DESKTOP, actions);
    click(items, "Copy path");
    expect(calls).toEqual([{ op: "copy", args: ["/srv/app/main.rs"] }]);
    expect(JSON.stringify(calls)).not.toContain("tauri.localhost");
  });

  it("carries the line range into the editor action", () => {
    const { calls, actions } = recordingActions();
    const items = buildLinkMenuItems(classifyLinkTarget("/srv/app/main.rs#L12-L18"), DESKTOP, actions);
    click(items, "Open in editor");
    expect(calls).toEqual([{ op: "openInEditor", args: ["/srv/app/main.rs", 12, 18] }]);
  });

  it("routes the native actions at the parsed path", () => {
    const { calls, actions } = recordingActions();
    const items = buildLinkMenuItems(classifyLinkTarget("C:\\logs\\run.log:4"), DESKTOP, actions);
    click(items, "Reveal in File Explorer");
    click(items, "Open with default app");
    expect(calls).toEqual([
      { op: "revealPath", args: ["C:\\logs\\run.log"] },
      { op: "openPath", args: ["C:\\logs\\run.log"] },
    ]);
  });

  it("offers browser and copy actions for a web target in either client", () => {
    const { calls, actions } = recordingActions();
    for (const caps of [DESKTOP, BROWSER]) {
      const items = buildLinkMenuItems(classifyLinkTarget("www.example.com/docs"), caps, actions);
      expect(labels(items)).toEqual(["Open in browser", "Copy link"]);
      click(items, "Open in browser");
      click(items, "Copy link");
    }
    // The normalized url is what gets used, so a bare host copies as openable.
    expect(calls.every((entry) => entry.args[0] === "https://www.example.com/docs")).toBe(true);
  });

  it("declines an unsupported target so the selection menu still opens", () => {
    const { actions } = recordingActions();
    expect(buildLinkMenuItems(classifyLinkTarget("mailto:dot@example.com"), DESKTOP, actions)).toEqual([]);
    expect(buildLinkMenuItems(classifyLinkTarget("#anchor"), DESKTOP, actions)).toEqual([]);
  });
});
