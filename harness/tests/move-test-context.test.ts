/**
 * The move test contexts are themselves a public authoring contract, so they get
 * the same treatment as one: the in-memory backings must behave like the real
 * ones, and the members that would reach a live harness must fail loudly rather
 * than return undefined.
 *
 * The last test is the one that matters over time — it drives a real built-in
 * move's handlers through the factory, so this cannot become a mock that only
 * satisfies its own tests.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestMoveApiContext, createTestMoveContext } from "../move-test-context";

describe("createTestMoveApiContext", () => {
  test("state round-trips in memory and is readable from the handle", async () => {
    const { ctx, currentState } = createTestMoveApiContext({ state: { turns: 1 } });
    expect(await ctx.state.get()).toEqual({ turns: 1 });

    await ctx.state.set({ turns: 2 });
    expect(await ctx.state.get()).toEqual({ turns: 2 });
    expect(currentState()).toEqual({ turns: 2 });

    await ctx.state.delete();
    expect(await ctx.state.get()).toBeUndefined();
    expect(currentState()).toBeUndefined();
  });

  test("the process-scoped store is separate from state", () => {
    const { ctx, currentStore, currentState } = createTestMoveApiContext({ state: "s", store: "t" });
    ctx.setStore("changed");
    expect(ctx.store()).toBe("changed");
    expect(currentStore()).toBe("changed");
    expect(currentState()).toBe("s");
  });

  test("emit, notify, sendMessage and insertArtifact are recorded in order", async () => {
    const { ctx, emitted, notified, sentMessages, artifacts } = createTestMoveApiContext();

    ctx.emit({ type: "board", fen: "start" });
    ctx.emit({ type: "board", fen: "e4" });
    ctx.notify("your move");
    ctx.notify("with payload", { type: "board" });
    await ctx.sendMessage("session-a", "hello");
    const artifactId = ctx.insertArtifact({ sessionId: "s", name: "out.png", mime: "image/png", path: "/tmp/out.png" });

    expect(emitted).toEqual([{ type: "board", fen: "start" }, { type: "board", fen: "e4" }]);
    expect(notified).toEqual([{ message: "your move" }, { message: "with payload", emit: { type: "board" } }]);
    expect(sentMessages).toEqual([{ sessionId: "session-a", message: "hello" }]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.name).toBe("out.png");
    expect(artifactId).toBe(1);
  });

  test("secrets report configured values without touching the real secrets file", () => {
    const { ctx } = createTestMoveApiContext({ secrets: { API_KEY: "sk-test", EMPTY: "" } });
    expect(ctx.secrets.resolve("API_KEY")).toBe("sk-test");
    expect(ctx.secrets.isSet("API_KEY")).toBe(true);
    // An empty value is configured-but-blank, which is not "set" for a caller
    // deciding whether it can make a request.
    expect(ctx.secrets.isSet("EMPTY")).toBe(false);
    expect(ctx.secrets.isSet("ABSENT")).toBe(false);
    expect(ctx.secrets.resolve("ABSENT")).toBeUndefined();
  });

  test("database queries default to empty results rather than throwing", () => {
    // "No sessions yet" is a real state a move must handle, so the default is a
    // valid answer instead of a failure.
    const { ctx } = createTestMoveApiContext();
    expect(ctx.db.listSessions()).toEqual([]);
    expect(ctx.db.getSession("missing")).toBeNull();
    expect(ctx.db.searchSessions("anything")).toEqual([]);
    expect(ctx.db.getMoveHistory("test-move")).toEqual([]);
    expect(ctx.db.getSessionMessages("s")).toEqual([]);
  });

  test("a supplied database query is used and the rest still default", () => {
    const { ctx } = createTestMoveApiContext({
      db: { listSessions: () => [{ id: "s1", preview: "hi", profile: null, status: "idle", lastMessageAt: 0 }] },
    });
    expect(ctx.db.listSessions()).toHaveLength(1);
    expect(ctx.db.searchSessions("x")).toEqual([]);
  });

  test("orchestration members throw a message naming the member", async () => {
    const { ctx } = createTestMoveApiContext({ moveName: "chess" });
    await expect(ctx.createSession({ profile: "p", prompt: "go" })).rejects.toThrow(/chess.*createSession/s);
    await expect(ctx.triggerAction("a")).rejects.toThrow(/triggerAction/);
    await expect(ctx.activateMove({ moveName: "other" })).rejects.toThrow(/activateMove/);
    await expect(ctx.channels.send("ops", { text: "x" })).rejects.toThrow(/channels\.send/);
    await expect(ctx.model.complete({ prompt: "x" })).rejects.toThrow(/model\.complete/);
    expect(() => ctx.watchSessionTurns("s", () => {})).toThrow(/watchSessionTurns/);
  });

  test("an override replaces a throwing member", async () => {
    const spawned: string[] = [];
    const { ctx } = createTestMoveApiContext({
      overrides: {
        createSession: async (opts) => { spawned.push(opts.prompt); return "new-session"; },
      },
    });
    expect(await ctx.createSession({ profile: "p", prompt: "review this" })).toBe("new-session");
    expect(spawned).toEqual(["review this"]);
  });

  test("identity fields default and are overridable", () => {
    const fallback = createTestMoveApiContext();
    expect(fallback.ctx.caller).toBe("agent");
    expect(fallback.ctx.moveName).toBe("test-move");

    const explicit = createTestMoveApiContext({
      cwd: "/project", moveName: "chess", sessionId: "s-1", instanceId: "i-1", caller: "user",
    });
    expect(explicit.ctx.cwd).toBe("/project");
    expect(explicit.ctx.sessionId).toBe("s-1");
    expect(explicit.ctx.instanceId).toBe("i-1");
    expect(explicit.ctx.caller).toBe("user");
  });
});

describe("createTestMoveContext", () => {
  test("gather-time fields and form inputs are present", () => {
    const { ctx } = createTestMoveContext({ inputs: { topic: "release" }, userProfile: "dot" });
    expect(ctx.inputs).toEqual({ topic: "release" });
    expect(ctx.userProfile).toBe("dot");
    expect(ctx.session.exchangeCount).toBe(0);
    expect(ctx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("session fields merge over the defaults", () => {
    const { ctx } = createTestMoveContext({ session: { lastAssistantText: "prior answer", seq: 4 } });
    expect(ctx.session.lastAssistantText).toBe("prior answer");
    expect(ctx.session.seq).toBe(4);
    expect(ctx.session.profile).toBeUndefined();
  });

  test("meta is captured", () => {
    const { ctx, meta } = createTestMoveContext();
    ctx.meta("docCount", 12);
    expect(meta).toEqual({ docCount: 12 });
  });

  test("run throws by default and records the attempted command", async () => {
    // Silently returning "" would let a move that shells out appear to work.
    const { ctx, commands } = createTestMoveContext({ moveName: "build" });
    await expect(ctx.run("git status")).rejects.toThrow(/ctx\.run/);
    expect(commands).toEqual(["git status"]);
  });

  test("a supplied run is used and still recorded", async () => {
    const { ctx, commands } = createTestMoveContext({ run: async () => "clean" });
    expect(await ctx.run("git status")).toBe("clean");
    expect(commands).toEqual(["git status"]);
  });

  test("the harness bridge throws rather than reaching a live harness", async () => {
    const { ctx } = createTestMoveContext({ moveName: "handoff" });
    await expect(ctx.harness.createSession({ profile: "p", prompt: "x" })).rejects.toThrow(/harness\.createSession/);
    await expect(ctx.harness.notify({ channel: "ops", body: "x" })).rejects.toThrow(/harness\.notify/);
  });

  test("plugin settings are readable", () => {
    const { ctx } = createTestMoveContext({ pluginSettings: { endpoint: "http://localhost:1234" } });
    expect(ctx.pluginSettings.get("endpoint")).toBe("http://localhost:1234");
    expect(ctx.pluginSettings.all()).toEqual({ endpoint: "http://localhost:1234" });
  });
});

describe("driving a real built-in move", () => {
  // The guard against this becoming a self-satisfying mock: docs-doctor's
  // `validate` is production code, and it resolves the path it is given against
  // `ctx.cwd` — so the factory's cwd has to be real for this to pass at all.
  test("docs-doctor's validate op runs on a context built by the factory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "modus-move-test-ctx-"));
    try {
      mkdirSync(join(cwd, "profiles"), { recursive: true });
      writeFileSync(join(cwd, "profiles", "good.json"), JSON.stringify({
        prompt: "You are a reviewer.",
        description: "Reviews code.",
        provider: "claude-code",
      }));

      const { handlers } = await import("../moves/docs-doctor/context");
      const { ctx } = createTestMoveApiContext({ cwd, moveName: "docs-doctor" });

      const valid = await handlers.validate!(ctx, { schema: "agent-profile", path: "profiles/good.json" });
      expect(valid.ok).toBe(true);

      // The move's own path guard still applies, which proves the handler is
      // reading the factory's cwd rather than a default.
      const escaped = await handlers.validate!(ctx, { schema: "agent-profile", path: "../outside.json" });
      expect(escaped.ok).toBe(false);
      expect(escaped.error).toContain("inside the project directory");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
