import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { vaultEnvironment } from "../cli-vault";
import { canonicalVaultRoot, createVault, requireRegisteredVault } from "../vault-registry";
import { removeTreeAfterExit } from "./fixtures/remove-tree";

type BoundaryResult = {
  modusHome: string;
  writableRoot: string;
  dataDir: string;
  runtimeDir: string;
  profiles: string[];
  projects: string[];
  plugins: string[];
  skills: string[];
  secret: string | null;
  secretPath: string;
  databasePath: string;
  runtimeCanary: string;
  sensitiveTempDir: string;
};

type BackendBoundaryResult = {
  vaultStatus: number;
  createStatus: number;
  profiles: string[];
  projects: string[];
  plugins: string[];
  skills: string[];
};

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSkill(root: string, name: string): void {
  write(
    join(root, "skills", name, "SKILL.md"),
    `---\ndescription: ${name}\n---\n\n${name}\n`,
  );
}

async function inspectNamedVault(
  harnessDir: string,
  resources: string,
  mainHome: string,
  slug: string,
  root: string,
  project: string,
): Promise<BoundaryResult> {
  const registered = requireRegisteredVault(slug, { modusHome: mainHome });
  const moduleUrl = (name: string) => pathToFileURL(join(harnessDir, name)).href;
  const script = `
    const { Database } = await import("bun:sqlite");
    const { join } = await import("node:path");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const app = await import(${JSON.stringify(moduleUrl("app-paths.ts"))});
    const profiles = await import(${JSON.stringify(moduleUrl("profiles.ts"))});
    const plugins = await import(${JSON.stringify(moduleUrl("modus-plugins.ts"))});
    const skills = await import(${JSON.stringify(moduleUrl("skills.ts"))});
    const secrets = await import(${JSON.stringify(moduleUrl("secrets.ts"))});
    const databases = await import(${JSON.stringify(moduleUrl("database-paths.ts"))});
    const sensitiveTemp = await import(${JSON.stringify(moduleUrl("sensitive-temp.ts"))});
    secrets.loadSecrets();
    const databasePath = databases.resolveDatabasePath("boundary.db");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE IF NOT EXISTS boundary (slug TEXT NOT NULL)");
    database.query("INSERT INTO boundary (slug) VALUES (?)").run(${JSON.stringify(slug)});
    database.close();
    mkdirSync(app.APP_PATHS.runtimeDir, { recursive: true });
    const runtimeCanary = join(app.APP_PATHS.runtimeDir, "boundary.txt");
    writeFileSync(runtimeCanary, ${JSON.stringify(slug)});
    const sensitiveTempDir = sensitiveTemp.createSensitiveTempDirectory();
    sensitiveTemp.writeSensitiveTempFile(sensitiveTempDir, "boundary.txt", ${JSON.stringify(slug)});
    console.log("RESULT:" + JSON.stringify({
      modusHome: app.APP_PATHS.modusHome,
      writableRoot: app.APP_PATHS.writableRoot,
      dataDir: app.APP_PATHS.dataDir,
      runtimeDir: app.APP_PATHS.runtimeDir,
      profiles: profiles.listProfileNames(${JSON.stringify(project)}),
      projects: profiles.listProjects().map((entry) => entry.id),
      plugins: plugins.listPluginRegistrations().map((entry) => entry.id),
      skills: skills.listInstalledSkills(${JSON.stringify(project)}).map((entry) => entry.name),
      secret: secrets.resolveSecret("BOUNDARY_SECRET") ?? null,
      secretPath: secrets.getSecretsInfo().path,
      databasePath,
      runtimeCanary,
      sensitiveTempDir,
    }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: vaultEnvironment({
      ...process.env,
      NODE_ENV: "production",
      MODUS_HOME: mainHome,
      MODUS_RESOURCES_DIR: resources,
      MODUS_DATA_DIR: join(mainHome, "data"),
      MODUS_LOGS_DIR: join(mainHome, "logs"),
      MODUS_RUNTIME_DIR: join(mainHome, "runtime"),
      MODUS_CACHE_DIR: join(mainHome, "cache"),
    }, slug, registered.root),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const result = stdout.split(/\r?\n/).find((line) => line.startsWith("RESULT:"));
  expect(result, `${stdout}\n${stderr}`).toBeDefined();
  return JSON.parse(result!.slice("RESULT:".length)) as BoundaryResult;
}

async function exerciseNamedBackend(
  harnessDir: string,
  mainHome: string,
  slug: string,
  root: string,
  project: string,
): Promise<BackendBoundaryResult> {
  const token = `vault-boundary-${crypto.randomUUID()}`;
  const readyPath = join(root, "runtime", "server-ready.json");
  const backend = Bun.spawn([process.execPath, "run", "index.ts"], {
    cwd: harnessDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: vaultEnvironment({
      ...process.env,
      NODE_ENV: "production",
      AGENT_CWD: project,
      HARNESS_HOST: "127.0.0.1",
      HARNESS_PORT: "0",
      HARNESS_TOKEN: token,
      MODUS_HOME: mainHome,
      MODUS_RESOURCES_DIR: harnessDir,
      MODUS_DESKTOP_MANAGED: "1",
      MODUS_DESKTOP_READY_FILE: readyPath,
    }, slug, root),
  });
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(readyPath) && backend.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    if (!existsSync(readyPath)) {
      if (backend.exitCode === null) backend.kill();
      const stderr = await new Response(backend.stderr).text();
      throw new Error(`named Vault backend did not become ready: ${stderr}`);
    }
    const ready = JSON.parse(readFileSync(readyPath, "utf8")) as { port: number };
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const headers = { Authorization: `Bearer ${token}` };
    const [vaultResponse, createResponse, profiles, projects, plugins, skills] = await Promise.all([
      fetch(`${baseUrl}/api/vaults`, { headers }),
      fetch(`${baseUrl}/api/vaults`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "sibling", root: join(root, "sibling"), mode: "initialize" }),
      }),
      fetch(`${baseUrl}/api/profiles?cwd=${encodeURIComponent(project)}`, { headers }).then((response) => response.json()) as Promise<Array<{ name: string }>>,
      fetch(`${baseUrl}/api/projects`, { headers }).then((response) => response.json()) as Promise<Array<{ id: string }>>,
      fetch(`${baseUrl}/api/plugins`, { headers }).then((response) => response.json()) as Promise<Array<{ id: string }>>,
      fetch(`${baseUrl}/api/skills?cwd=${encodeURIComponent(project)}`, { headers }).then((response) => response.json()) as Promise<Array<{ name: string }>>,
    ]);
    await fetch(`${baseUrl}/api/internal/shutdown`, { method: "POST", headers }).catch(() => undefined);
    return {
      vaultStatus: vaultResponse.status,
      createStatus: createResponse.status,
      profiles: profiles.map((entry) => entry.name),
      projects: projects.map((entry) => entry.id),
      plugins: plugins.map((entry) => entry.id),
      skills: skills.map((entry) => entry.name),
    };
  } finally {
    const deadline = Date.now() + 5_000;
    while (backend.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    if (backend.exitCode === null) backend.kill();
    await backend.exited;
  }
}

describe("named Vault folder boundary", () => {
  test("two arbitrary registered roots remain complete and leave Main untouched", async () => {
    const base = mkdtempSync(join(tmpdir(), "modus-vault-roots-"));
    const harnessDir = resolveTestSourceDir(import.meta.dir, "..");
    const mainHome = join(base, "main");
    const resources = join(base, "resources");
    const mainPlugin = join(base, "external", "main-plugin");
    const mainProject = join(base, "external", "main-project");
    writeJson(join(resources, "plugin.json"), { id: "modus-core", name: "Modus Core" });
    writeJson(join(mainHome, "profiles", "agents", "main-only.json"), { prompt: "Main only" });
    writeJson(join(mainHome, "projects.json"), {
      "main-project": { name: "Main", path: mainProject, created: "2026-08-19T00:00:00.000Z" },
    });
    writeJson(join(mainHome, "plugins.json"), {
      plugins: [{ id: "main-only", path: mainPlugin, enabled: true }],
    });
    writeJson(join(mainPlugin, ".modus", "plugin.json"), { id: "main-only", name: "Main only" });
    writeSkill(mainHome, "main-only");
    write(join(mainHome, "secrets.env"), "BOUNDARY_SECRET=main\n");
    write(join(mainHome, "data", "main-canary.txt"), "main-data\n");
    write(join(mainHome, "runtime", "main-canary.txt"), "main-runtime\n");

    const fixtures = [
      { slug: "alpha", root: join(base, "portable-alpha"), project: join(base, "external", "alpha-project") },
      { slug: "beta", root: join(base, "deep", "user-chosen-beta"), project: join(base, "external", "beta-project") },
    ];

    try {
      for (const fixture of fixtures) {
        createVault({ slug: fixture.slug, root: fixture.root, mode: "initialize" }, { modusHome: mainHome });
        writeJson(join(fixture.root, "profiles", "agents", `${fixture.slug}-profile.json`), {
          prompt: `${fixture.slug} profile`,
        });
        writeJson(join(fixture.root, "projects.json"), {
          [`${fixture.slug}-project`]: {
            name: fixture.slug,
            path: fixture.project,
            created: "2026-08-19T00:00:00.000Z",
          },
        });
        const plugin = join(base, "external", `${fixture.slug}-plugin`);
        writeJson(join(fixture.root, "plugins.json"), {
          plugins: [{ id: `${fixture.slug}-plugin`, path: plugin, enabled: true }],
        });
        writeJson(join(plugin, ".modus", "plugin.json"), {
          id: `${fixture.slug}-plugin`,
          name: `${fixture.slug} plugin`,
        });
        writeSkill(fixture.root, `${fixture.slug}-skill`);
        write(join(fixture.root, "secrets.env"), `BOUNDARY_SECRET=${fixture.slug}\n`);
      }

      const mainSnapshot = {
        profiles: readFileSync(join(mainHome, "profiles", "agents", "main-only.json"), "utf8"),
        projects: readFileSync(join(mainHome, "projects.json"), "utf8"),
        plugins: readFileSync(join(mainHome, "plugins.json"), "utf8"),
        skill: readFileSync(join(mainHome, "skills", "main-only", "SKILL.md"), "utf8"),
        secrets: readFileSync(join(mainHome, "secrets.env"), "utf8"),
        registry: readFileSync(join(mainHome, "vaults.json"), "utf8"),
      };

      const results: BoundaryResult[] = [];
      for (const fixture of fixtures) {
        const result = await inspectNamedVault(
          harnessDir,
          resources,
          mainHome,
          fixture.slug,
          fixture.root,
          fixture.project,
        );
        results.push(result);
        const expectedRoot = canonicalVaultRoot(fixture.root);
        expect(normalize(result.modusHome)).toBe(normalize(expectedRoot));
        expect(normalize(result.writableRoot)).toBe(normalize(expectedRoot));
        expect(normalize(result.dataDir)).toBe(normalize(join(expectedRoot, "data")));
        expect(normalize(result.runtimeDir)).toBe(normalize(join(expectedRoot, "runtime")));
        expect(result.profiles).toContain(`user:${fixture.slug}-profile`);
        expect(result.profiles).not.toContain("user:main-only");
        expect(result.projects).toEqual([`${fixture.slug}-project`]);
        expect(result.plugins).toEqual([`${fixture.slug}-plugin`]);
        expect(result.skills).toContain(`${fixture.slug}-skill`);
        expect(result.skills).not.toContain("main-only");
        expect(result.secret).toBe(fixture.slug);
        expect(normalize(result.secretPath)).toBe(normalize(join(expectedRoot, "secrets.env")));
        expect(normalize(result.databasePath)).toBe(normalize(join(expectedRoot, "data", "boundary.db")));
        expect(normalize(result.runtimeCanary)).toBe(normalize(join(expectedRoot, "runtime", "boundary.txt")));
        expect(normalize(result.sensitiveTempDir).startsWith(normalize(join(expectedRoot, "tmp")))).toBe(true);
      }

      expect(results[0]!.databasePath).not.toBe(results[1]!.databasePath);
      expect(results[0]!.runtimeCanary).not.toBe(results[1]!.runtimeCanary);
      const live = await exerciseNamedBackend(
        harnessDir,
        mainHome,
        fixtures[0]!.slug,
        canonicalVaultRoot(fixtures[0]!.root),
        fixtures[0]!.project,
      );
      expect(live.vaultStatus).toBe(403);
      expect(live.createStatus).toBe(403);
      expect(live.profiles).toContain("user:alpha-profile");
      expect(live.profiles).not.toContain("user:main-only");
      expect(live.projects).toEqual(["alpha-project"]);
      expect(live.plugins).toContain("alpha-plugin");
      expect(live.plugins).not.toContain("main-only");
      expect(live.skills).toContain("alpha-skill");
      expect(live.skills).not.toContain("main-only");
      expect(readFileSync(join(mainHome, "profiles", "agents", "main-only.json"), "utf8")).toBe(mainSnapshot.profiles);
      expect(readFileSync(join(mainHome, "projects.json"), "utf8")).toBe(mainSnapshot.projects);
      expect(readFileSync(join(mainHome, "plugins.json"), "utf8")).toBe(mainSnapshot.plugins);
      expect(readFileSync(join(mainHome, "skills", "main-only", "SKILL.md"), "utf8")).toBe(mainSnapshot.skill);
      expect(readFileSync(join(mainHome, "secrets.env"), "utf8")).toBe(mainSnapshot.secrets);
      expect(readFileSync(join(mainHome, "vaults.json"), "utf8")).toBe(mainSnapshot.registry);
      expect(readFileSync(join(mainHome, "data", "main-canary.txt"), "utf8")).toBe("main-data\n");
      expect(readFileSync(join(mainHome, "runtime", "main-canary.txt"), "utf8")).toBe("main-runtime\n");
      expect(existsSync(join(mainHome, "data", "boundary.db"))).toBe(false);
      expect(existsSync(join(mainHome, "runtime", "boundary.txt"))).toBe(false);
    } finally {
      await removeTreeAfterExit(base);
    }
  }, 30_000);
});
