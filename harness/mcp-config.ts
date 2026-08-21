import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { getGlobalConfigLayers, getProfileConfigPath, type McpServerConfig, type Profile } from "./profiles";

export type ResolvedMcpConfig = {
  servers: Record<string, McpServerConfig>;
  origins: Record<string, string>;
};

function readMcpFile(filePath: string): Record<string, McpServerConfig> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? servers : {};
  } catch (error) {
    console.warn(`[mcp] Failed to read ${filePath}:`, error);
    return {};
  }
}

function configuredPath(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function anchoredServer(config: McpServerConfig, baseDir: string): McpServerConfig {
  if (!("command" in config) || !config.args) return { ...config };
  const args = [...config.args];
  const index = args.indexOf("--directory");
  if (index >= 0 && args[index + 1] && !isAbsolute(args[index + 1]!)) {
    args[index + 1] = resolve(baseDir, args[index + 1]!);
  }
  return { ...config, args };
}

export function resolveMcpServers(options: {
  cwd?: string;
  profileName?: string;
  profile?: Profile;
  sessionServers?: Record<string, unknown>;
}): ResolvedMcpConfig {
  const cwd = options.cwd ?? process.cwd();
  const servers: Record<string, McpServerConfig> = {};
  const origins: Record<string, string> = {};
  const merge = (entries: Record<string, McpServerConfig> | undefined, origin: string, baseDir: string) => {
    for (const [name, config] of Object.entries(entries ?? {})) {
      servers[name] = anchoredServer(config, baseDir);
      origins[name] = origin;
    }
  };

  for (const filePath of [
    join(cwd, ".claude", "mcp.json"),
    join(cwd, ".mcp.json"),
    join(cwd, ".modus", "mcp.json"),
  ]) merge(readMcpFile(filePath), filePath, dirname(filePath));

  for (const layer of getGlobalConfigLayers(cwd)) {
    const baseDir = layer.path ? dirname(layer.path) : cwd;
    if (layer.config.mcpConfig) {
      const filePath = configuredPath(layer.config.mcpConfig, baseDir);
      merge(readMcpFile(filePath), `global:${filePath}`, dirname(filePath));
    }
    merge(layer.config.mcpServers, layer.path ? `global:${layer.path}` : "global", baseDir);
  }

  const profilePath = options.profileName ? getProfileConfigPath(options.profileName, cwd) : undefined;
  const profileBase = profilePath ? dirname(profilePath) : cwd;
  if (options.profile?.mcpConfig) {
    const filePath = configuredPath(options.profile.mcpConfig, profileBase);
    merge(readMcpFile(filePath), `profile:${filePath}`, dirname(filePath));
  }
  merge(options.profile?.mcpServers, "profile", profileBase);
  merge(options.sessionServers as Record<string, McpServerConfig> | undefined, "session", cwd);
  return { servers, origins };
}
