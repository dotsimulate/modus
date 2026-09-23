import { describe, expect, test } from "bun:test";
import { loadMoveProfileNames, visibleAgentProfiles } from "../../ui/src/profile-visibility";

const profiles = [
  { name: "user:dev", displayName: "dev", origin: "user" as const },
  { name: "user:other", displayName: "other", origin: "user" as const },
  { name: "project:builder", displayName: "builder", origin: "project" as const },
  { name: "project:reviewer", displayName: "reviewer", origin: "project" as const },
  { name: "plugin:tools/researcher", origin: "plugin" as const },
  { name: "plugin:tools/hidden", origin: "plugin" as const },
];
const visibility = { agentProfiles: ["dev"], hiddenPluginProfiles: ["plugin:tools/hidden"] };

describe("move agent profile options", () => {
  test("a one-profile user whitelist does not hide the target project's profiles", () => {
    expect(visibleAgentProfiles(profiles, visibility).map(p => p.name)).toEqual([
      "user:dev", "project:builder", "project:reviewer", "plugin:tools/researcher",
    ]);
  });

  test("qualified profile keys survive collisions in display names", () => {
    const rows = [profiles[0]!, { name: "project:dev", displayName: "dev", origin: "project" as const }];
    expect(visibleAgentProfiles(rows, visibility).map(p => p.name)).toEqual(["user:dev", "project:dev"]);
  });

  test("no whitelist includes all profiles except explicitly hidden plugin entries", () => {
    expect(visibleAgentProfiles(profiles, { hiddenPluginProfiles: visibility.hiddenPluginProfiles }).map(p => p.name))
      .toEqual(profiles.slice(0, -1).map(p => p.name));
  });

  test("loads the form's project and user profile, not the plugin or global composer directory", async () => {
    const calls: string[] = [];
    const client = {
      listProfiles: async (cwd?: string) => { calls.push(`profiles:${cwd}`); return profiles; },
      getUserProfile: async (name: string) => { calls.push(`user:${name}`); return visibility; },
    };
    expect(await loadMoveProfileNames(client, "/projects/target", "workspace")).toEqual([
      "Current profile", "user:dev", "project:builder", "project:reviewer", "plugin:tools/researcher",
    ]);
    expect(calls).toEqual(["profiles:/projects/target", "user:workspace"]);
  });

  test("renderer and submit resolver share a request but reopening fetches fresh profiles", async () => {
    let count = 0;
    const client = {
      listProfiles: async () => { count++; return profiles; },
      getUserProfile: async () => visibility,
    };
    const first = loadMoveProfileNames(client, "/projects/target", "workspace");
    const second = loadMoveProfileNames(client, "/projects/target", "workspace");
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(count).toBe(1);
    await loadMoveProfileNames(client, "/projects/target", "workspace");
    expect(count).toBe(2);
  });

  test("different project/user/backend scopes never share profile requests", async () => {
    const calls: string[] = [];
    const client = {
      listProfiles: async (cwd?: string) => { calls.push(cwd!); return [{ name: `project:${cwd}`, origin: "project" as const }]; },
      getUserProfile: async () => visibility,
    };
    const results = await Promise.all([
      loadMoveProfileNames(client, "/a", "first"),
      loadMoveProfileNames(client, "/b", "first"),
      loadMoveProfileNames(client, "/a", "second"),
      loadMoveProfileNames({ ...client }, "/a", "first"),
    ]);
    expect(calls).toEqual(["/a", "/b", "/a", "/a"]);
    expect(results[0]).toEqual(["Current profile", "project:/a"]);
    expect(results[1]).toEqual(["Current profile", "project:/b"]);
  });

  test("failed profile lookups propagate instead of substituting unrelated names, and can retry", async () => {
    let failed = true;
    const client = {
      listProfiles: async () => { if (failed) throw new Error("offline"); return profiles; },
      getUserProfile: async () => visibility,
    };
    await expect(loadMoveProfileNames(client, "/target", "workspace")).rejects.toThrow("offline");
    failed = false;
    expect(await loadMoveProfileNames(client, "/target", "workspace")).toContain("project:builder");
  });

  test("an unscoped user sees loaded profiles without an invented user-profile request", async () => {
    const client = {
      listProfiles: async () => profiles,
      getUserProfile: async () => { throw new Error("must not be called"); },
    };
    expect(await loadMoveProfileNames(client, "/target")).toEqual(["Current profile", ...profiles.map(p => p.name)]);
  });
});
