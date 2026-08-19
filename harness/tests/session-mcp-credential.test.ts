import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildModusMcpServer } from "../profiles";
import {
  LEGACY_PROVIDER_MCP_BEARER_VAR,
  bindSessionMcpCredential,
  isSessionMcpCredential,
  mintSessionMcpCredential,
  revokeSessionMcpCredential,
  revokeSessionMcpCredentials,
  validateSessionMcpCredential,
} from "../session-mcp-credential";

const profilesSource = readFileSync(join(import.meta.dir, "..", "profiles.ts"), "utf8");
const sessionManagerSource = readFileSync(join(import.meta.dir, "..", "session-manager.ts"), "utf8");
const actionRunnerSource = readFileSync(join(import.meta.dir, "..", "action-runner.ts"), "utf8");
const codexSource = readFileSync(join(import.meta.dir, "..", "providers", "codex.ts"), "utf8");

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const previousHarnessToken = process.env.HARNESS_TOKEN;
const previousLegacyBearer = process.env[LEGACY_PROVIDER_MCP_BEARER_VAR];

afterEach(() => {
  if (previousHarnessToken === undefined) delete process.env.HARNESS_TOKEN;
  else process.env.HARNESS_TOKEN = previousHarnessToken;
  if (previousLegacyBearer === undefined) delete process.env[LEGACY_PROVIDER_MCP_BEARER_VAR];
  else process.env[LEGACY_PROVIDER_MCP_BEARER_VAR] = previousLegacyBearer;
});

describe("session-scoped Modus MCP credentials", () => {
  test("the shared builder never reads the supervisor bearer", () => {
    expect(functionBody(profilesSource, "buildModusMcpServer")).not.toContain("HARNESS_TOKEN");
  });

  test("built configs use only the supplied session credential by default", () => {
    process.env.HARNESS_TOKEN = "supervisor-canary";
    delete process.env[LEGACY_PROVIDER_MCP_BEARER_VAR];

    const plain = buildModusMcpServer();
    const scoped = buildModusMcpServer("scope-one", "session-mcp-canary");

    expect(plain.headers).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain("supervisor-canary");
    expect(scoped).toMatchObject({
      type: "http",
      headers: { Authorization: "Bearer session-mcp-canary" },
    });
    expect(scoped.url.endsWith("/api/mcp/modus/scope-one")).toBe(true);
    expect(JSON.stringify(scoped)).not.toContain("supervisor-canary");
  });

  test("the explicit compatibility switch restores the legacy supervisor bearer", () => {
    process.env.HARNESS_TOKEN = "legacy-supervisor-canary";
    process.env[LEGACY_PROVIDER_MCP_BEARER_VAR] = "1";
    expect(buildModusMcpServer()).toMatchObject({
      headers: { Authorization: "Bearer legacy-supervisor-canary" },
    });
  });

  test("a credential authorizes only its exact MCP endpoint", () => {
    const credential = mintSessionMcpCredential("scope-two");
    expect(credential).toBeTruthy();
    expect(isSessionMcpCredential(credential!)).toBe(true);
    expect(validateSessionMcpCredential(credential!, "/api/mcp/modus/scope-two")).toBe(true);
    expect(validateSessionMcpCredential(credential!, "/api/mcp/modus")).toBe(false);
    expect(validateSessionMcpCredential(credential!, "/api/sessions")).toBe(false);
    revokeSessionMcpCredential(credential!);
  });

  test("disposing a bound session revokes its credential", () => {
    const credential = mintSessionMcpCredential();
    expect(credential).toBeTruthy();
    bindSessionMcpCredential("disposed-session", credential!);
    expect(validateSessionMcpCredential(credential!, "/api/mcp/modus")).toBe(true);
    revokeSessionMcpCredentials("disposed-session");
    expect(validateSessionMcpCredential(credential!, "/api/mcp/modus")).toBe(false);
  });

  test("dispose, force-clear, reap, and shutdown source paths all revoke", () => {
    for (const name of ["forceClearActiveSession", "reclaimSession", "shutdownAll"]) {
      expect(functionBody(sessionManagerSource, name)).toContain("revokeSessionMcpCredentials");
    }
  });

  test("both primary spawn paths mint before startSession and bind after init", () => {
    const interactive = functionBody(sessionManagerSource, "startSessionWithMoves");
    const actionStart = actionRunnerSource.slice(
      actionRunnerSource.indexOf("const skillScopeKey = createSkillScope"),
      actionRunnerSource.indexOf("exec.currentSessionId = session.sessionId"),
    );
    for (const source of [interactive, actionStart]) {
      const executableSource = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(executableSource.indexOf("mintSessionMcpCredential")).toBeGreaterThanOrEqual(0);
      expect(executableSource.indexOf("mintSessionMcpCredential")).toBeLessThan(executableSource.indexOf("startSession("));
      expect(executableSource.indexOf("bindSessionMcpCredential")).toBeGreaterThan(executableSource.indexOf("waitForProviderInit"));
    }
  });

  test("follow-up provider contexts retain the scoped MCP endpoint and skill scope", () => {
    const start = functionBody(sessionManagerSource, "startSession");
    expect(start).toContain("mcpServers: opts.mcpServers");
    expect(start).toContain("skillScopeKey: opts.skillScopeKey");

    // Ordinary follow-up, steering, and queued-resume paths all rebuild a
    // TurnContext from the retained object.
    expect(sessionManagerSource.match(/\.\.\.session\._configOverrides/g)).toHaveLength(3);
  });

  test("Codex makes an authenticated built-in Modus MCP failure fatal", () => {
    const start = codexSource.indexOf("function buildRemoteCodexMcpServer");
    const end = codexSource.indexOf("\n/**", start);
    const remoteBuilder = codexSource.slice(start, end);
    expect(remoteBuilder).toContain('name === "modus"');
    expect(remoteBuilder).toContain("serverConfig.required = true");
  });
});
