import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addEvent, getEvents, getSessionMessage, upsertSession } from "../db";
import {
  activateMoveBindings,
  gatherMoveOnce,
  handleMoveApiSubmit,
  rekeyMoveByToken,
  resolveMoveToolViewToken,
} from "../move-runner";

const projectRoot = mkdtempSync(join(tmpdir(), "modus-profile-move-"));
const fixtureMoveName = "profile-api-fixture";
const fixtureMoveDir = join(projectRoot, ".modus", "moves", fixtureMoveName);
mkdirSync(fixtureMoveDir, { recursive: true });
writeFileSync(join(fixtureMoveDir, "move.json"), JSON.stringify({
  name: fixtureMoveName,
  label: "Profile API fixture",
  mode: "inline",
  submit: { required: false },
  api: {
    tokenPrefix: "profile-fixture",
    ops: {
      ping: { description: "Return pong." },
      artifact: { description: "Attach an artifact." },
    },
  },
  toolView: {
    component: "tool-view.tsx",
    ops: ["ping"],
  },
}));
writeFileSync(join(fixtureMoveDir, "context.ts"), [
  "export async function gather(ctx: any) {",
  "  return `fixture token: ${ctx.apiToken}`;",
  "}",
  "export const handlers = {",
  "  ping: async () => ({ ok: true, message: 'pong' }),",
  "  artifact: async (ctx: any, data: any) => ({",
  "    ok: true,",
  "    artifactId: ctx.insertArtifact({ sessionId: ctx.sessionId, seq: data.seq, name: 'fixture.txt', mime: 'text/plain', path: ctx.cwd }),",
  "  }),",
  "};",
].join("\n"));

const registryPath = join(
  projectRoot,
  ".modus",
  "moves",
  fixtureMoveName,
  "state",
  "_registry.json",
);

function readRegistry(): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return {};
  }
}

/** Merge a row in without clobbering rows written by earlier tests. */
function seedRegistryRow(token: string, row: Record<string, unknown>): void {
  mkdirSync(join(projectRoot, ".modus", "moves", fixtureMoveName, "state"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ ...readRegistry(), [token]: row }, null, 2));
}

afterAll(() => {
  if (projectRoot.startsWith(tmpdir())) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("profile move lifecycle", () => {
  test("does not gather a profile move already injected into the logical session", async () => {
    const sessionId = `profile-move-${crypto.randomUUID()}`;
    upsertSession({
      id: sessionId,
      preview: "profile move lifecycle",
      messageCount: 0,
      costUsd: 0,
      cwd: projectRoot,
    });
    addEvent(sessionId, 1, "user", "prompt", JSON.stringify({
      message: {
        content: `<!-- move:${fixtureMoveName} -->\nalready injected\n<!-- /move:${fixtureMoveName} -->\n\nhello`,
      },
    }));

    const result = await activateMoveBindings(
      [{ name: fixtureMoveName }],
      "",
      projectRoot,
      undefined,
      {
        persistentOnly: false,
        skipPreviouslyInjectedForSession: sessionId,
        persistInlineApiRegistrations: true,
      },
    );

    expect(result.inlineContext).toBeNull();
    expect(result.apiTokens).toEqual([]);
  });

  test("persists and rekeys a stateless profile move API registration", async () => {
    const gathered = await gatherMoveOnce(
      fixtureMoveName,
      "",
      projectRoot,
      undefined,
      {},
      { persistApiRegistration: true },
    );

    expect(gathered?.apiToken).toStartWith("mapi-profile-fixture-");
    const token = gathered!.apiToken!;
    const before = readRegistry();
    expect(before[token]).toMatchObject({ sessionId: "", persistState: false });

    expect(rekeyMoveByToken(token, "logical-session")).toBe(true);
    const after = readRegistry();
    expect(after[token]).toMatchObject({
      sessionId: "logical-session",
      persistState: false,
    });
  });

  // An interactively-invoked API move gets no persistApiRegistration option, and
  // declares no api.state. It still has to survive a harness restart, because its
  // token is baked into the transcript and may be called hours later.
  test("persists an API registration that never opted into state persistence", async () => {
    const gathered = await gatherMoveOnce(fixtureMoveName, "", projectRoot, undefined, {});

    const token = gathered!.apiToken!;
    expect(readRegistry()[token]).toMatchObject({ persistState: false });
    expect(await resolveMoveToolViewToken(token)).toMatchObject({
      moveName: fixtureMoveName,
      cwd: projectRoot,
      sessionId: "",
      toolView: { component: "tool-view.tsx", ops: ["ping"] },
    });
    expect((await resolveMoveToolViewToken(token))!.instanceId).toBe(token.split("-").at(-1)!);
  });

  test("recovers a token whose registration exists only on disk", async () => {
    const sessionId = `disk-only-${crypto.randomUUID()}`;
    upsertSession({
      id: sessionId,
      preview: "disk-only recovery",
      messageCount: 0,
      costUsd: 0,
      cwd: projectRoot,
    });
    const token = "mapi-profile-fixture-diskonly";
    seedRegistryRow(token, {
      instanceId: "diskonly",
      sessionId,
      cwd: projectRoot,
      createdAt: Date.now(),
      persistState: false,
    });

    const result = await handleMoveApiSubmit(token, { op: "ping" });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("pong");
    expect(await resolveMoveToolViewToken(token)).toMatchObject({
      moveName: fixtureMoveName,
      instanceId: "diskonly",
      sessionId,
      toolView: { component: "tool-view.tsx" },
    });
  });

  test("handler artifacts attach to the live turn and durable history", async () => {
    const sessionId = `artifact-${crypto.randomUUID()}`;
    upsertSession({
      id: sessionId,
      preview: "artifact fixture",
      messageCount: 0,
      costUsd: 0,
      cwd: projectRoot,
    });
    addEvent(sessionId, 5, "assistant", "message", JSON.stringify({
      message: { content: [{ type: "text", text: "artifact turn" }] },
    }));
    const gathered = await gatherMoveOnce(fixtureMoveName, sessionId, projectRoot, undefined, {});

    const result = await handleMoveApiSubmit(gathered!.apiToken!, { op: "artifact", seq: 5 });
    expect(result.ok).toBe(true);
    expect(typeof result.artifactId).toBe("number");
    expect(getSessionMessage(sessionId, 5)?.artifacts).toEqual([
      expect.objectContaining({ id: result.artifactId, name: "fixture.txt", seq: 5 }),
    ]);
    expect(getEvents(sessionId).some((event) =>
      event.type === "system" && event.subtype === "artifact_attached"
    )).toBe(true);
  });

  test("drops to fallback when a registered move has been deleted", async () => {
    const moveName = `deleted-tool-view-${crypto.randomUUID()}`;
    const moveDir = join(projectRoot, ".modus", "moves", moveName);
    mkdirSync(moveDir, { recursive: true });
    writeFileSync(join(moveDir, "move.json"), JSON.stringify({
      name: moveName,
      label: "Deleted tool view",
      description: "Deleted tool view fixture",
      api: { ops: { ping: { description: "Return pong." } } },
      toolView: { component: "tool-view.tsx" },
    }));
    writeFileSync(join(moveDir, "context.ts"), [
      "export async function gather() { return 'deleted tool view'; }",
      "export const handlers = { ping: async () => ({ ok: true }) };",
      "",
    ].join("\n"));

    const gathered = await gatherMoveOnce(moveName, "", projectRoot, undefined, {});
    const token = gathered!.apiToken!;
    expect(await resolveMoveToolViewToken(token)).toBeDefined();

    rmSync(join(moveDir, "move.json"));
    expect(await resolveMoveToolViewToken(token)).toBeUndefined();
  });

  test("reports an unregistered token as a lifecycle failure, not an expiry", async () => {
    const result = await handleMoveApiSubmit("mapi-profile-fixture-missing", { op: "ping" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not registered");
    expect(result.error).toContain("did not expire");
  });

  test("prunes registrations past the retention window when the registry is rewritten", async () => {
    const stale = "mapi-profile-fixture-stale";
    seedRegistryRow(stale, {
      instanceId: "stale",
      sessionId: "",
      cwd: projectRoot,
      createdAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      persistState: false,
    });
    expect(readRegistry()[stale]).toBeDefined();

    const gathered = await gatherMoveOnce(fixtureMoveName, "", projectRoot, undefined, {});

    const after = readRegistry();
    expect(after[stale]).toBeUndefined();
    expect(after[gathered!.apiToken!]).toBeDefined();
  });
});
