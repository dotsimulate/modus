import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { sessionTagsMatchTrigger } from "../session-trigger-tags";

const runnerSource = readFileSync(resolve(import.meta.dir, "../action-runner.ts"), "utf8");

describe("session trigger tag gate", () => {
  test("with no filters, only action-spawned sessions are skipped", () => {
    expect(sessionTagsMatchTrigger({}, [])).toBe(true);
    expect(sessionTagsMatchTrigger({}, ["pinned"])).toBe(true);
    expect(sessionTagsMatchTrigger({}, ["internal"])).toBe(false);
  });

  test("an explicit excludeTags replaces the internal default", () => {
    expect(sessionTagsMatchTrigger({ excludeTags: ["auto-titled"] }, ["auto-titled"])).toBe(false);
    expect(sessionTagsMatchTrigger({ excludeTags: ["auto-titled"] }, ["internal"])).toBe(true);
  });

  test("includeTags fires only on sessions carrying at least one of them", () => {
    const trigger = { includeTags: ["opted-in", "narrated"] };
    expect(sessionTagsMatchTrigger(trigger, [])).toBe(false);
    expect(sessionTagsMatchTrigger(trigger, ["pinned"])).toBe(false);
    expect(sessionTagsMatchTrigger(trigger, ["opted-in"])).toBe(true);
    expect(sessionTagsMatchTrigger(trigger, ["pinned", "narrated"])).toBe(true);
  });

  test("exclusion wins over inclusion", () => {
    expect(sessionTagsMatchTrigger({ includeTags: ["opted-in"] }, ["opted-in", "internal"])).toBe(false);
  });

  test("an empty includeTags is no filter rather than a gate nothing passes", () => {
    expect(sessionTagsMatchTrigger({ includeTags: [] }, [])).toBe(true);
  });

  test("the runner's session dispatch goes through the gate", () => {
    expect(runnerSource).toContain("if (!sessionTagsMatchTrigger(trigger, session.tags)) continue;");
  });
});
