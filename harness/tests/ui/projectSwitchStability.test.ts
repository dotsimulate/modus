import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI_ROOT = join(import.meta.dir, "..", "..", "ui", "src");

describe("project switch effect keys", () => {
  it("loads themes from one resolved dependency instead of both settling inputs", () => {
    const source = readFileSync(join(UI_ROOT, "providers", "ProfileProvider.tsx"), "utf8");
    expect(source).toContain("const themeCwd = projectRoot || setupState.cwd.trim() || undefined;");
    expect(source).toContain('loadAndApplyProjectUiState(themeCwd, "profile-project");');
    expect(source).toContain("}, [themeCwd]);");
    expect(source).not.toContain("}, [projectRoot, setupState.cwd]);");
  });

  it("keys client extensions to the stable project root with a cwd fallback", () => {
    const source = readFileSync(join(UI_ROOT, "components", "ClientExtensionsBoot.tsx"), "utf8");
    expect(source).toContain("const extCwd = projectRoot || activeCwd;");
    expect(source).toContain("reportClientTiming(\"clientExtensions\"");
  });

  it("forwards renderer timings through the authenticated backend route", () => {
    const helper = readFileSync(join(UI_ROOT, "client-timing.ts"), "utf8");
    const backend = readFileSync(join(UI_ROOT, "..", "..", "index.ts"), "utf8");
    expect(helper).toContain("if (!isTauriRuntime()) return;");
    expect(helper).toContain("`${API_BASE}/api/client-timing`");
    expect(backend).toContain('app.post("/api/client-timing"');
  });
});
