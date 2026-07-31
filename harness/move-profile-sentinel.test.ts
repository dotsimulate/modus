import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CURRENT_PROFILE_SENTINEL, type MoveConfig } from "./move-types";
import { activateMoveBindings, resolveAgentProfileInputs } from "./move-runner";

const projectRoot = mkdtempSync(join(tmpdir(), "modus-profile-sentinel-"));
const fixtureMoveName = "sentinel-fixture";
const fixtureMoveDir = join(projectRoot, ".modus", "moves", fixtureMoveName);
mkdirSync(fixtureMoveDir, { recursive: true });
writeFileSync(join(fixtureMoveDir, "move.json"), JSON.stringify({
  name: fixtureMoveName,
  label: "Sentinel fixture",
  mode: "inline",
  submit: { required: false },
  inputs: [
    { name: "profile", type: "select", optionsSource: { type: "agentProfiles" } },
    { name: "note", type: "text" },
  ],
}));
writeFileSync(join(fixtureMoveDir, "context.ts"), [
  "export async function gather(ctx: any) {",
  "  return `profile=[${ctx.inputs.profile}] note=[${ctx.inputs.note}]`;",
  "}",
].join("\n"));

afterAll(() => {
  if (projectRoot.startsWith(tmpdir())) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

const pickerConfig = {
  name: "x",
  label: "x",
  inputs: [
    { name: "profile", type: "select", optionsSource: { type: "agentProfiles" } },
    { name: "target", type: "select", options: "{{agentProfiles}}" },
    { name: "note", type: "text" },
  ],
} as MoveConfig;

describe("resolveAgentProfileInputs", () => {
  test("translates the sentinel on optionsSource pickers", () => {
    const out = resolveAgentProfileInputs(
      pickerConfig,
      { profile: CURRENT_PROFILE_SENTINEL },
      "my-agent",
    );
    expect(out.profile).toBe("my-agent");
  });

  test("translates the sentinel on {{agentProfiles}} template pickers", () => {
    const out = resolveAgentProfileInputs(
      pickerConfig,
      { target: CURRENT_PROFILE_SENTINEL },
      "my-agent",
    );
    expect(out.target).toBe("my-agent");
  });

  test("leaves a text input holding the same string alone", () => {
    const out = resolveAgentProfileInputs(
      pickerConfig,
      { note: CURRENT_PROFILE_SENTINEL },
      "my-agent",
    );
    expect(out.note).toBe(CURRENT_PROFILE_SENTINEL);
  });

  test("leaves everything alone when no profile is known", () => {
    const inputs = { profile: CURRENT_PROFILE_SENTINEL };
    const out = resolveAgentProfileInputs(pickerConfig, inputs, undefined);
    expect(out).toBe(inputs);
    expect(out.profile).toBe(CURRENT_PROFILE_SENTINEL);
  });

  test("does not mutate the caller's inputs object", () => {
    const inputs = { profile: CURRENT_PROFILE_SENTINEL };
    resolveAgentProfileInputs(pickerConfig, inputs, "my-agent");
    expect(inputs.profile).toBe(CURRENT_PROFILE_SENTINEL);
  });

  test("real profile names pass through untouched", () => {
    const inputs = { profile: "explicit-choice" };
    const out = resolveAgentProfileInputs(pickerConfig, inputs, "my-agent");
    expect(out).toBe(inputs);
  });
});

describe("sentinel translation through move activation", () => {
  test("a pre-spawn inline gather sees the session profile, not the sentinel", async () => {
    const result = await activateMoveBindings(
      [{ name: fixtureMoveName, inputs: { profile: CURRENT_PROFILE_SENTINEL, note: "kept" } }],
      "", // phase 1: no session yet — profile must come from the caller
      projectRoot,
      undefined,
      { persistentOnly: false, logPrefix: "sentinel-test", agentProfile: "spawning-profile" },
    );
    expect(result.inlineContext).toContain("profile=[spawning-profile]");
    expect(result.inlineContext).toContain("note=[kept]");
  });

  test("without a known profile the sentinel reaches the move verbatim", async () => {
    const result = await activateMoveBindings(
      [{ name: fixtureMoveName, inputs: { profile: CURRENT_PROFILE_SENTINEL, note: "n" } }],
      "",
      projectRoot,
      undefined,
      { persistentOnly: false, logPrefix: "sentinel-test" },
    );
    expect(result.inlineContext).toContain(`profile=[${CURRENT_PROFILE_SENTINEL}]`);
  });
});
