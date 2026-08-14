import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { activateMove } from "../move-runner";

const projectRoot = mkdtempSync(join(tmpdir(), "modus-move-dispatch-"));
const moveDir = join(projectRoot, ".modus", "moves", "dispatch-fixture");
mkdirSync(moveDir, { recursive: true });
writeFileSync(join(moveDir, "move.json"), JSON.stringify({
  name: "dispatch-fixture",
  label: "Dispatch fixture",
  description: "Tests inline activation transport",
  mode: "inline",
  prompt: "gathered prompt",
  submit: { required: false },
}));

afterAll(() => {
  if (projectRoot.startsWith(tmpdir())) rmSync(projectRoot, { recursive: true, force: true });
});

describe("inline move activation dispatch contract", () => {
  test("returns the gathered prompt and explicitly says the caller must send it", async () => {
    const result = await activateMove({ moveName: "dispatch-fixture", inputs: {}, cwd: projectRoot });
    if ("error" in result) throw new Error(result.error);
    expect(result).toMatchObject({
      mode: "inline",
      requiresDispatch: true,
    });
    expect(result.prompt).toContain("Dispatch fixture");
    expect(result.spawnedSessionId).toBeUndefined();
  });
});
