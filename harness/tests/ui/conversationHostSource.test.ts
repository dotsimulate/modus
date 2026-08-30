import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const uiRoot = join(import.meta.dir, "..", "..", "ui", "src");
const host = readFileSync(join(uiRoot, "widgets", "session-chat.widget.tsx"), "utf8");
const resources = readFileSync(join(uiRoot, "useConversationResources.ts"), "utf8");
const transcript = readFileSync(join(uiRoot, "widgets", "conversation-transcript.widget.tsx"), "utf8");
const projection = readFileSync(join(uiRoot, "widgets", "conversation-projection.widget.tsx"), "utf8");
const hostStyles = readFileSync(join(uiRoot, "styles", "components", "conversation-host.css"), "utf8");
const loader = readFileSync(join(uiRoot, "components", "authored-component-loader.ts"), "utf8");
const moveLoader = readFileSync(join(uiRoot, "components", "move-component-loader.ts"), "utf8");

describe("conversation host safety ownership", () => {
  test("registry resolution replaces the closed presentation branch", () => {
    expect(host).toContain("resolveConversationLens");
    expect(host).not.toContain('=== "turns"');
    expect(host).not.toContain("chat.presentation");
  });

  test("Chat Display is the only selector and has no transient shadow", () => {
    expect(host).not.toContain("conversation-host-bar");
    expect(host).not.toContain("useTransientConversationLens");
    expect(resources).not.toContain("transientLensId");
    expect(resources).not.toContain("useSyncExternalStore");
  });

  test("Transcript recovery is diagnostic-only and persists through the configured scope", () => {
    expect(host).toContain('const showTranscriptRecovery = requestedLensId !== "core:transcript"');
    expect(host).toContain("activeRuntimeFailure || resolution.reason || lensDegraded");
    expect(host).toContain("writableProjectChatConfig");
    expect(host).toContain("writeDeviceInterfaceSettings(next)");
    expect(host).toContain("`${diagnosticSource} · ${statusReason}`");
    expect(host).not.toContain('resolution.resolvedId !== "core:transcript"');
  });

  test("discovery in progress renders a wait instead of a lens failure", () => {
    // Resolving against a null registry reports every candidate as
    // "not discovered for this project", so the host must not resolve until
    // discovery settles, and a session with no cwd must still get a transcript.
    expect(host).toContain("if (!registry) return <WidgetEmptyState>loading conversation");
    expect(host).toContain('if (resources.status === "idle") {');
  });

  test("stalled discovery is retried on browser resume", () => {
    expect(resources).toContain("subscribeBrowserResume");
    expect(resources).toContain('state.status === "ready" && state.discoveredFor === cwd');
  });

  test("permissions and queued sends remain outside the authored PageView", () => {
    const pageView = host.indexOf("<PageView");
    expect(pageView).toBeGreaterThan(-1);
    expect(host.indexOf("<QueuedMessage")).toBeLessThan(pageView);
    expect(host.indexOf("<PermissionOverlay")).toBeGreaterThan(pageView);
  });

  test("the compatibility adapter binds session and selected turn through the existing bus", () => {
    expect(host).toContain("parentBus={parentBus}");
    expect(host).toContain('{ local: "sessionId", parent: "sessionId", direction: "down" }');
    expect(host).toContain("conversationCwd: cwd");
    expect(host).toContain('{ local: "turnNumber", parent: "turnNumber", direction: "twoWay" }');
  });

  test("the nested lens page cannot become a second transcript scroll owner", () => {
    expect(hostStyles).toMatch(/\.conversation-host-stage > \.dashboard\s*\{[^}]*overflow: hidden;/s);
    expect(hostStyles).toMatch(/\.conversation-host-stage > \.dashboard\s*\{[^}]*gap: 0;/s);
  });

  test("a headerless unlabelled turn rail uses compact mark padding", () => {
    const turnStyles = readFileSync(join(uiRoot, "styles", "components", "session-turn.css"), "utf8");
    expect(turnStyles).toMatch(/\.session-turns--bare \.session-turns-mark\s*\{[^}]*padding: 3px 2px;/s);
    expect(turnStyles).toMatch(/\.session-turns--bare \.session-turns-rail\s*\{[^}]*overflow-x: hidden;/s);
  });

  test("git context reaches the canonical transcript and default remains settings-owned", () => {
    expect(transcript).toContain("cwd={session.cwd ?? null}");
    expect(transcript).toContain("conversation.showGitEvents");
  });
});

describe("authored projection authority and cleanup", () => {
  test("remote backends fail closed and runtime failures reach the host", () => {
    expect(projection).toContain('BACKEND_TARGET.mode === "remote"');
    expect(projection).toContain("modus:conversation-projection-error");
  });

  test("projection discovery stays qualified to the host project even without a session cwd", () => {
    expect(projection).toContain('pageContext?.get("conversationCwd")');
    expect(projection).toContain("session?.cwd ?? null");
  });

  test("component switches abort loads, unmount React, and evict cache-none modules", () => {
    expect(projection).toContain("active = false");
    expect(projection).toContain('projection.definition?.cache === "none"');
    expect(projection).toContain("evictAuthoredComponent(moduleUrl)");
  });

  test("moves and projections share one host-import loader", () => {
    expect(loader).toContain("redirectHostModules(js)");
    expect(loader).toContain("bindHostImports(js)");
    expect(moveLoader).toContain("loadAuthoredComponent<Props>");
    expect(projection).toContain("loadAuthoredComponent<ConversationProjectionPropsV1>");
  });
});
