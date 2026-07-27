import { describe, expect, test } from "bun:test";
import {
  maskMoveApiTokens,
  parseMessageText,
  userAuthoredMessageText,
  wrapSkillContext,
} from "./src/move-context";

describe("move context message parsing", () => {
  test("separates injected context from the user-authored prompt", () => {
    const content = [
      "<!-- move:modus-brain -->",
      "Use token `mapi-brain-abc12345`.",
      "<!-- /move:modus-brain -->",
      "",
      "How do profiles work?",
    ].join("\n");

    expect(parseMessageText(content)).toEqual([
      {
        type: "move_context",
        moveName: "modus-brain",
        content: "Use token `mapi-brain-abc12345`.",
      },
      { type: "text", text: "How do profiles work?" },
    ]);
    expect(userAuthoredMessageText(content)).toBe("How do profiles work?");
  });

  test("supports multiple move blocks and preserves malformed markers as text", () => {
    const content = [
      "<!-- move:first -->",
      "one",
      "<!-- /move:first -->",
      "",
      "<!-- move:second -->",
      "two",
      "<!-- /move:second -->",
      "",
      "hello",
    ].join("\n");

    expect(parseMessageText(content).filter((part) => part.type === "move_context"))
      .toHaveLength(2);
    expect(userAuthoredMessageText(content)).toBe("hello");

    const malformed = "<!-- move:first -->\none\n<!-- /move:other -->\nhello";
    expect(parseMessageText(malformed)).toEqual([{ type: "text", text: malformed }]);
  });

  test("masks move capability tokens in expanded display text", () => {
    expect(maskMoveApiTokens("token mapi-brain-abc12345"))
      .toBe("token mapi-…2345");
  });
});

describe("skill context message parsing", () => {
  test("folds a staged skill out of the authored text", () => {
    const content = [
      wrapSkillContext("skill-probe", "Reply with MODUS-SKILL-PROBE-OK-7Q4F."),
      "",
      "check the auth flow",
    ].join("\n");

    expect(parseMessageText(content)).toEqual([
      {
        type: "skill_context",
        skillName: "skill-probe",
        content: "Reply with MODUS-SKILL-PROBE-OK-7Q4F.",
      },
      { type: "text", text: "check the auth flow" },
    ]);
    expect(userAuthoredMessageText(content)).toBe("check the auth flow");
  });

  test("stacks several skills and keeps them distinct", () => {
    const content = [
      wrapSkillContext("alpha", "First."),
      "",
      wrapSkillContext("beta", "Second."),
      "",
      "go",
    ].join("\n");

    const parts = parseMessageText(content);
    expect(parts.filter((p) => p.type === "skill_context")).toHaveLength(2);
    expect(userAuthoredMessageText(content)).toBe("go");
  });

  test("moves and skills coexist in one message", () => {
    const content = [
      "<!-- move:modus-brain -->",
      "Move body.",
      "<!-- /move:modus-brain -->",
      "",
      wrapSkillContext("skill-probe", "Skill body."),
      "",
      "both please",
    ].join("\n");

    const parts = parseMessageText(content);
    expect(parts.map((p) => p.type)).toEqual(["move_context", "skill_context", "text"]);
    expect(userAuthoredMessageText(content)).toBe("both please");
  });

  test("a skill body containing the marker syntax cannot swallow the prompt", () => {
    // The closing tag backreferences both kind and name, so a mismatched inner
    // opener stays inert rather than eating everything after it.
    const content = [
      wrapSkillContext("outer", "Docs mention <!-- skill:inner --> as syntax."),
      "",
      "still mine",
    ].join("\n");

    expect(userAuthoredMessageText(content)).toBe("still mine");
  });

  test("skill names round-trip through the wrapper", () => {
    expect(wrapSkillContext("a.b-c_1", "x")).toBe(
      "<!-- skill:a.b-c_1 -->\nx\n<!-- /skill:a.b-c_1 -->",
    );
    expect(parseMessageText(wrapSkillContext("a.b-c_1", "x"))[0]).toEqual({
      type: "skill_context",
      skillName: "a.b-c_1",
      content: "x",
    });
  });
});
