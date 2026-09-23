import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProfileSchema } from "../profile-schemas";
import type { MoveContext } from "../move-types";
import { gather, onSubmit } from "../moves/create-profile/context";

const projectRoot = mkdtempSync(join(tmpdir(), "modus-create-profile-"));
const move = JSON.parse(readFileSync(new URL("../moves/create-profile/move.json", import.meta.url), "utf8"));
const ctx = { cwd: projectRoot, token: "test-token", schema: "test-schema" } as MoveContext;

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

test("create-profile effort choices and gathered guidance match the runtime profile schema", async () => {
  expect(move.schema.properties.effort.enum).toEqual(ProfileSchema.shape.effort.unwrap().options);
  expect(await gather(ctx)).toContain('effort?: "off" | "low" | "medium" | "high" | "xhigh" | "max";');
});

test("create-profile saves xhigh and rejects an invalid effort", async () => {
  const valid = { name: "deep-review", description: "Reviews complex work", prompt: "You are a reviewer.", effort: "xhigh" };
  expect(move.schema.properties.effort.enum).toContain(valid.effort);
  expect(ProfileSchema.safeParse(valid).success).toBe(true);

  const saved = await onSubmit(ctx, valid);
  expect(saved.error).toBeUndefined();
  const savedPath = join(projectRoot, ".modus", "profiles", "agents", "deep-review.json");
  expect(JSON.parse(readFileSync(savedPath, "utf8"))).toEqual({
    description: valid.description,
    prompt: valid.prompt,
    effort: "xhigh",
  });

  const invalid = { ...valid, name: "invalid-effort", effort: "ultra" };
  expect(move.schema.properties.effort.enum).not.toContain(invalid.effort);
  expect(ProfileSchema.safeParse(invalid).success).toBe(false);
  expect((await onSubmit(ctx, invalid)).error).toContain("effort must be one of");
  expect(existsSync(join(projectRoot, ".modus", "profiles", "agents", "invalid-effort.json"))).toBe(false);
});
