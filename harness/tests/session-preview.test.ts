import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { contentPreview, type MessageContent } from "../session-manager";

describe("session content previews", () => {
  test("removes complete injected context before truncating", () => {
    const prompt = [
      "<!-- move:modus-brain -->",
      `Use capability token mapi-brain-${"x".repeat(100)}.`,
      "<!-- /move:modus-brain -->",
      "",
      "What do we need to do next?",
    ].join("\n");

    expect(contentPreview(prompt)).toBe("What do we need to do next?");
  });

  test("uses safe injected-context names when no authored text remains", () => {
    expect(contentPreview([
      "<!-- move:modus-brain -->",
      "private injected instructions",
      "<!-- /move:modus-brain -->",
    ].join("\n"))).toBe("modus-brain move");

    expect(contentPreview([
      "<!-- skill:review -->",
      "private skill instructions",
      "<!-- /skill:review -->",
    ].join("\n"))).toBe("review skill");
  });

  test("preserves image counts while previewing authored text", () => {
    const content: MessageContent = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      {
        type: "text",
        text: "<!-- move:vision -->\ninspect first\n<!-- /move:vision -->\n\nDescribe this image",
      },
    ];
    expect(contentPreview(content)).toBe("[1 image] Describe this image");
  });

  test("all provider preview assignments use the shared helper", () => {
    const providers = [
      "claude-code.ts",
      "claude-code-pty.ts",
      "codex.ts",
      "cursor.ts",
      "gemini-cli.ts",
    ];
    for (const file of providers) {
      const source = readFileSync(join(resolveTestSourceDir(import.meta.dir, ".."), "providers", file), "utf8");
      expect(source).not.toMatch(/preview\s*=\s*typeof[^;]+slice\(0,\s*80\)/);
    }
  });
});
