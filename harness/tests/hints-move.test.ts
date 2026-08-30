/**
 * The hints move's submit contract.
 *
 * `onSubmit` is the whole interface between the routing agent and the
 * hints-launcher widget: it serializes into the move_runs summary column and
 * the widget JSON.parses it back. Nothing else validates that boundary — the
 * agent writes free JSON, `move.json`'s `schemaHint` is a prompt string with no
 * runtime force, and a malformed card renders as a dead button rather than an
 * error. So the stripping rules are the contract, and they live here.
 *
 * The important behaviour here is **completion**. The first live run against
 * gpt-5.6-luna returned `{kind:"profile", target:"project:modus-core-dev",
 * label, reason, confidence}` and nothing else — no project, no cwd, no
 * prompt — despite the prompt saying "ALWAYS set project and cwd". There is no
 * enforcement available either: `validateSchema` only reaches top-level keys,
 * and an `onSubmit` rejection marks the run `error`, which the widget treats as
 * terminal. So `onSubmit` completes what it can from the agent catalog instead
 * of rejecting, and these tests pin that a minimal card still opens something.
 */

import { describe, expect, test } from "bun:test";
import { onSubmit } from "../moves/hints/context";
import type { MoveContext } from "../move-types";

const CTX = {} as MoveContext;

type Payload = {
  recommendations: Array<Record<string, unknown>>;
  passthrough: boolean;
  note?: string;
};

async function submit(data: Record<string, unknown>): Promise<Payload | { error: string }> {
  const result = await onSubmit(CTX, data, {});
  if (result.error) return { error: result.error };
  return JSON.parse(result.message as string) as Payload;
}

const VALID = {
  kind: "new",
  target: "modus-ui-lab",
  label: "Open the UI lab on the launcher",
  reason: "the draft describes interface work in the modus repo",
  confidence: 0.62,
  project: "modus",
  cwd: "D:/Projects/app",
  prompt: "I want to check in on the launcher work.",
  references: ["abc-1 · 2026-08-21 · shipped conversation lenses"],
};

describe("hints onSubmit", () => {
  test("carries the launch triple and the staged prompt through intact", async () => {
    const payload = await submit({ recommendations: [VALID], passthrough: false }) as Payload;
    expect(payload.passthrough).toBe(false);
    expect(payload.recommendations).toHaveLength(1);
    expect(payload.recommendations[0]).toEqual({
      kind: "new",
      target: "modus-ui-lab",
      profile: "modus-ui-lab",
      label: "Open the UI lab on the launcher",
      reason: "the draft describes interface work in the modus repo",
      confidence: 0.62,
      project: "modus",
      cwd: "D:/Projects/app",
      prompt: "I want to check in on the launcher work.",
      references: ["abc-1 · 2026-08-21 · shipped conversation lenses"],
    });
  });

  test("accepts a recommendation with no launch fields at all", async () => {
    const bare = { kind: "session", target: "ses-1", label: "continue", reason: "strong match" };
    const payload = await submit({ recommendations: [bare], passthrough: false }) as Payload;
    expect(payload.recommendations[0]).toEqual(bare);
  });

  test("drops empty-string launch fields rather than emitting them blank", async () => {
    const payload = await submit({
      recommendations: [{ ...VALID, project: "   ", cwd: "", prompt: "  ", references: [] }],
      passthrough: false,
    }) as Payload;
    const rec = payload.recommendations[0]!;
    expect(rec).not.toHaveProperty("project");
    expect(rec).not.toHaveProperty("cwd");
    expect(rec).not.toHaveProperty("prompt");
    expect(rec).not.toHaveProperty("references");
    // `profile` is completed from `target`, so a "new" card always names an agent.
    expect(rec.profile).toBe("modus-ui-lab");
  });

  test("normalizes the pre-catalog kind name \"profile\" instead of dropping the card", async () => {
    const payload = await submit({
      recommendations: [{ ...VALID, kind: "profile" }],
      passthrough: false,
    }) as Payload;
    expect(payload.recommendations).toHaveLength(1);
    expect(payload.recommendations[0]!.kind).toBe("new");
  });

  test("completes a minimal new card — the exact shape the first live run produced", async () => {
    // kind/target/label/reason only, which is what gpt-5.6-luna actually sent.
    const payload = await submit({
      recommendations: [{
        kind: "profile",
        target: "project:modus-core-dev",
        label: "Modus Core Developer",
        reason: "No matching past session or move was found.",
        confidence: 0.46,
      }],
      passthrough: false,
    }) as Payload;
    const rec = payload.recommendations[0]!;
    expect(rec.kind).toBe("new");
    // The agent is always recoverable from the target even with no catalog hit,
    // so the card can still open a session rather than rendering a dead button.
    expect(rec.profile).toBe("project:modus-core-dev");
    expect(rec.confidence).toBe(0.46);
  });

  test("a session card is not given a profile it did not ask for", async () => {
    const payload = await submit({
      recommendations: [{ kind: "session", target: "ses-9", label: "continue", reason: "mid-flight" }],
      passthrough: false,
    }) as Payload;
    expect(payload.recommendations[0]).not.toHaveProperty("profile");
  });

  test("caps references at four and flattens each to one line", async () => {
    const payload = await submit({
      recommendations: [{ ...VALID, references: ["a\n  b", "c", "d", "e", "f"] }],
      passthrough: false,
    }) as Payload;
    const refs = payload.recommendations[0]!.references as string[];
    expect(refs).toHaveLength(4);
    expect(refs[0]).toBe("a b");
  });

  test("rejects a non-string reference without discarding the card", async () => {
    const payload = await submit({
      recommendations: [{ ...VALID, references: [42, "kept"] }],
      passthrough: false,
    }) as Payload;
    expect(payload.recommendations[0]!.references).toEqual(["kept"]);
  });

  test("strips a card with an unknown kind, a blank target, or a missing label", async () => {
    const payload = await submit({
      recommendations: [
        { ...VALID, kind: "page" },
        { ...VALID, target: "   " },
        { ...VALID, label: undefined },
        { ...VALID, reason: 7 },
        VALID,
      ],
      passthrough: false,
    }) as Payload;
    expect(payload.recommendations).toHaveLength(1);
    expect(payload.recommendations[0]!.target).toBe("modus-ui-lab");
  });

  test("clamps confidence into 0..1 and omits a non-numeric one", async () => {
    const payload = await submit({
      recommendations: [{ ...VALID, confidence: 4 }, { ...VALID, confidence: -1 }, { ...VALID, confidence: "high" }],
      passthrough: false,
    }) as Payload;
    expect(payload.recommendations[0]!.confidence).toBe(1);
    expect(payload.recommendations[1]!.confidence).toBe(0);
    expect(payload.recommendations[2]).not.toHaveProperty("confidence");
  });

  test("an empty result is an error unless passthrough is claimed", async () => {
    expect(await submit({ recommendations: [], passthrough: false })).toHaveProperty("error");
    const payload = await submit({ recommendations: [], passthrough: true }) as Payload;
    expect(payload).toEqual({ recommendations: [], passthrough: true });
  });

  test("everything stripped forces passthrough — the client must not show an empty card list", async () => {
    const payload = await submit({
      recommendations: [{ kind: "nonsense", target: "x", label: "y", reason: "z" }],
      passthrough: false,
    });
    expect(payload).toHaveProperty("error");
  });

  test("a non-array recommendations field is treated as empty, not thrown on", async () => {
    const payload = await submit({ recommendations: "oops", passthrough: true }) as Payload;
    expect(payload.recommendations).toEqual([]);
  });

  test("note survives when present and is omitted when it is not a string", async () => {
    const withNote = await submit({ recommendations: [VALID], passthrough: false, note: "two options" }) as Payload;
    expect(withNote.note).toBe("two options");
    const without = await submit({ recommendations: [VALID], passthrough: false, note: 3 }) as Payload;
    expect(without).not.toHaveProperty("note");
  });
});
