import { describe, expect, test } from "bun:test";
import { fetchProviderModels } from "../../providers/models";

describe("Claude Code model suggestions", () => {
  test("include current full IDs and durable aliases", async () => {
    const models = await fetchProviderModels("claude-code");
    const ids = models.map((model) => model.id);

    expect(ids).toContain("claude-opus-5-5");
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("default");
    expect(ids).toContain("best");
    expect(ids).toContain("opus");
    expect(ids).toContain("sonnet");
    expect(ids).toContain("haiku");
  });

  test("offers the same open-ended suggestions to the PTY provider", async () => {
    expect(await fetchProviderModels("claude-code-pty")).toEqual(
      await fetchProviderModels("claude-code"),
    );
  });
});
