const cwd = process.argv[2];
if (!cwd) throw new Error("cwd required");

const { getProfile } = await import("../../profiles");
const { resolveMcpServers } = await import("../../mcp-config");
const profile = getProfile("p", cwd);
if (!profile) throw new Error("profile p not found");
const resolved = resolveMcpServers({
  cwd,
  profileName: "p",
  profile,
  sessionServers: { same: { command: "session" }, sessionOnly: { command: "session-only" } },
});
process.stdout.write(JSON.stringify(resolved));
