import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve as resolvePath } from "path";
import { pathToFileURL } from "url";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function lens(id: string, label = id, widgetType = "session-turn") {
  return {
    contract: "conversation-lens@1",
    id,
    label,
    capabilities: { required: ["conversation.turn-content"] },
    layout: { kind: "widget", widget: { type: widgetType } },
    layouts: { mobile: { kind: "widget", widget: { type: widgetType } } },
  };
}

function projection(id: string) {
  return {
    contract: "conversation-projection@1",
    id,
    label: id,
    component: "component.tsx",
    cache: "none",
    capabilities: { consumes: ["conversation.turn-index"] },
    modes: ["overview"],
  };
}

describe("conversation resource discovery", () => {
  test("resolves source precedence, exposure, policy, diagnostics, and component identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-conversation-lenses-"));
    const home = join(root, "home");
    const resources = join(root, "resources");
    const project = join(root, "project");
    const plugin = join(root, "plugin");
    const blocked = join(root, "blocked-plugin");

    try {
      writeJson(join(resources, "plugin.json"), { id: "modus-core", name: "Modus Core" });
      writeJson(join(resources, "lenses", "transcript.json"), lens("core:transcript", "Transcript"));
      writeJson(join(resources, "lenses", "shared.json"), lens("shared", "harness shared"));
      writeJson(join(resources, "projections", "contact", "projection.json"), projection("contact"));
      writeFileSync(join(resources, "projections", "contact", "component.tsx"), "export default function Contact(){ return null }\n");

      writeJson(join(home, "plugins.json"), {
        plugins: [
          { id: "demo", path: plugin, enabled: true },
          { id: "blocked", path: blocked, enabled: true },
        ],
      });
      writeJson(join(home, "vault.json"), {
        plugins: { mode: "deny", allow: ["demo"] },
        projectAutomation: { mode: "allow-all" },
        channels: { mode: "allow-all" },
      });
      writeJson(join(home, "lenses", "shared.json"), lens("shared", "vault shared"));
      writeJson(join(home, "projections", "contact", "projection.json"), projection("contact"));
      writeFileSync(join(home, "projections", "contact", "component.tsx"), "export default function Contact(){ return null }\n");

      writeJson(join(plugin, ".modus", "plugin.json"), {
        id: "demo",
        name: "Demo",
        integration: { lenses: ["shared", "plugin-only", "contact-sheet"], projections: ["contact"] },
        contents: { lenses: { mode: "merge" }, projections: { mode: "merge" } },
      });
      writeJson(join(plugin, ".modus", "lenses", "shared.json"), lens("shared", "plugin shared"));
      writeJson(join(plugin, ".modus", "lenses", "plugin-only.json"), lens("plugin-only"));
      writeJson(join(plugin, ".modus", "lenses", "unexposed.json"), lens("unexposed"));
      writeJson(join(plugin, ".modus", "projections", "contact", "projection.json"), projection("contact"));
      writeFileSync(join(plugin, ".modus", "projections", "contact", "component.tsx"), "export default function Contact(){ return null }\n");

      writeJson(join(blocked, ".modus", "plugin.json"), {
        id: "blocked",
        integration: { lenses: ["blocked-only"], projections: ["blocked-view"] },
      });
      writeJson(join(blocked, ".modus", "lenses", "blocked.json"), lens("blocked-only"));
      writeJson(join(blocked, ".modus", "projections", "blocked-view", "projection.json"), projection("blocked-view"));
      writeFileSync(join(blocked, ".modus", "projections", "blocked-view", "component.tsx"), "export default function Blocked(){ return null }\n");

      writeJson(join(project, ".modus", "lenses", "shared.json"), lens("shared", "project shared"));
      writeJson(join(project, ".modus", "lenses", "reserved-transcript.json"), lens("core:transcript", "not safe"));
      writeJson(join(project, ".modus", "lenses", "bad-contract.json"), {
        ...lens("future"), contract: "conversation-lens@2",
      });
      writeJson(join(project, ".modus", "lenses", "contact-sheet.json"), {
        ...lens("contact-sheet", "Contact Sheet", "conversation-projection"),
        layout: { kind: "widget", widget: { type: "conversation-projection", projectionId: "contact" } },
      });
      writeJson(join(project, ".modus", "projections", "contact", "projection.json"), projection("contact"));
      const projectComponent = join(project, ".modus", "projections", "contact", "component.tsx");
      writeFileSync(projectComponent, "export default function Contact(){ return null }\n");

      const moduleUrl = pathToFileURL(join(resolvePath(import.meta.dir, ".."), "conversation-lenses.ts")).href;
      const script = `
        const resources = await import(${JSON.stringify(moduleUrl)});
        const registry = resources.listConversationResources(${JSON.stringify(project)});
        const projection = registry.projections.find((entry) => entry.id === "contact");
        const resolved = resources.resolveConversationProjectionComponent(
          "contact", ${JSON.stringify(project)}, projection.source.key,
        );
        const rejected = resources.resolveConversationProjectionComponent(
          "contact", ${JSON.stringify(project)}, "project:local:wrong",
        );
        console.log("RESULT:" + JSON.stringify({ registry, resolvedPath: resolved?.componentPath, rejected }));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          MODUS_HOME: home,
          MODUS_RESOURCES_DIR: resources,
          MODUS_DATA_DIR: join(root, "data"),
          MODUS_LOGS_DIR: join(root, "logs"),
          MODUS_RUNTIME_DIR: join(root, "runtime"),
          MODUS_CACHE_DIR: join(root, "cache"),
          HARNESS_SECRETS_FILE: join(root, "secrets.env"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("RESULT:"));
      expect(line, stdout).toBeDefined();
      const result = JSON.parse(line!.slice("RESULT:".length));

      expect(result.registry.contract).toBe("conversation-resources@1");
      expect(result.registry.lenses.find((entry: any) => entry.id === "shared").definition.label)
        .toBe("project shared");
      expect(result.registry.lenses.find((entry: any) => entry.id === "core:transcript").definition.label)
        .toBe("Transcript");
      expect(result.registry.diagnostics.some((entry: any) => (
        entry.id === "core:transcript" && entry.status === "invalid" && entry.source.kind === "project"
      ))).toBe(true);
      expect(result.registry.lenses.find((entry: any) => entry.id === "plugin-only").source.kind)
        .toBe("plugin");
      expect(result.registry.lenses.some((entry: any) => entry.id === "unexposed")).toBe(false);
      expect(result.registry.lenses.find((entry: any) => entry.id === "future").status)
        .toBe("incompatible");
      expect(result.registry.projections.find((entry: any) => entry.id === "contact").source.kind)
        .toBe("project");
      expect(result.registry.diagnostics.some((entry: any) => (
        entry.id === "blocked-only" && entry.status === "disabled" && /Vault policy/.test(entry.reason)
      ))).toBe(true);
      expect(result.registry.diagnostics.filter((entry: any) => entry.id === "shared" && entry.status === "shadowed").length)
        .toBe(3);
      expect(result.resolvedPath).toBe(projectComponent);
      expect(result.rejected).toBeNull();
      expect(JSON.stringify(result.registry)).not.toContain(project);
      expect(JSON.stringify(result.registry)).not.toContain(home);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown capabilities, reserved authored ids, and missing components", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-conversation-lenses-invalid-"));
    try {
      writeJson(join(root, ".modus", "lenses", "reserved.json"), lens("core:not-yours"));
      writeJson(join(root, ".modus", "lenses", "decorative.json"), {
        ...lens("decorative"),
        capabilities: { required: ["conversation.magic"] },
      });
      writeJson(join(root, ".modus", "lenses", "unknown-widget.json"), lens("unknown-widget", "unknown-widget", "not-a-widget"));
      writeJson(join(root, ".modus", "lenses", "missing-compose.json"), {
        ...lens("missing-compose"),
        capabilities: { required: ["conversation.compose"] },
      });
      writeJson(join(root, ".modus", "projections", "missing", "projection.json"), projection("missing"));
      const moduleUrl = pathToFileURL(join(resolvePath(import.meta.dir, ".."), "conversation-lenses.ts")).href;
      const script = `
        const resources = await import(${JSON.stringify(moduleUrl)});
        console.log("RESULT:" + JSON.stringify(resources.listConversationResources(${JSON.stringify(root)})));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          MODUS_HOME: join(root, "home"),
          MODUS_RESOURCES_DIR: join(root, "resources"),
          MODUS_DATA_DIR: join(root, "data"),
          MODUS_LOGS_DIR: join(root, "logs"),
          MODUS_RUNTIME_DIR: join(root, "runtime"),
          MODUS_CACHE_DIR: join(root, "cache"),
          HARNESS_SECRETS_FILE: join(root, "secrets.env"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const registry = JSON.parse(stdout.split("RESULT:")[1]!);
      expect(registry.lenses.some((entry: any) => entry.id === "core:not-yours")).toBe(false);
      expect(registry.diagnostics.find((entry: any) => entry.id === "core:not-yours").status).toBe("invalid");
      expect(registry.lenses.find((entry: any) => entry.id === "decorative").status).toBe("invalid");
      expect(registry.lenses.find((entry: any) => entry.id === "unknown-widget").reason).toContain("unknown-widget");
      expect(registry.lenses.find((entry: any) => entry.id === "missing-compose").reason).toContain("missing-required-capability");
      expect(registry.projections.find((entry: any) => entry.id === "missing").status).toBe("invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
