import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(import.meta.dir, "..", "..", "ui", "src", "components", "ProfileEditor.tsx"),
  "utf8",
);

describe("Profile editor prompt capabilities", () => {
  test("uses provider capabilities to disable unsupported prompt modes", () => {
    expect(source).toContain("selectedCapabilities?.profilePrompt?.supportedModes");
    expect(source).toContain('disabled={!supportedPromptModes.includes("append")}');
    expect(source).toContain('disabled={!supportedPromptModes.includes("custom")}');
    expect(source).toContain("selectedCapabilities.profilePrompt.summary");
  });

  test("labels project instructions generically and disables unavailable controls", () => {
    expect(source).toContain("load project instructions");
    expect(source).not.toContain("load CLAUDE.md");
    expect(source).toContain('disabled={projectInstructionControl !== "toggle"}');
    expect(source).toContain("selectedCapabilities.projectInstructions.sources");
  });
});
