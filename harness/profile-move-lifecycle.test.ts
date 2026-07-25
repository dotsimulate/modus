import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addEvent, upsertSession } from "./db";
import {
  activateMoveBindings,
  gatherMoveOnce,
  handleMoveApiSubmit,
  rekeyMoveByToken,
} from "./move-runner";

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
    },
  },
}));
writeFileSync(join(fixtureMoveDir, "context.ts"), [
  "export async function gather(ctx: any) {",
  "  return `fixture token: ${ctx.apiToken}`;",
  "}",
  "export const handlers = {",
  "  ping: async () => ({ ok: true, message: 'pong' }),",
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
