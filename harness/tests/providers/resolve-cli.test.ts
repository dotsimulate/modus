import { describe, expect, test } from "bun:test";
import {
  expandWindowsEnvRefs,
  parseRegistryPathValue,
  posixUserInstallDirs,
  readPersistedWindowsPath,
  regExecutable,
  npmShimNativeClaude,
  resolveClaudeCli,
  resolveCliFrom,
} from "../../providers/resolve-cli";
import { join } from "path";

describe("resolveCliFrom", () => {
  test("returns the first directory containing the command", () => {
    const dirs = ["/a/bin", "/b/bin", "/c/bin"];
    const found = resolveCliFrom("claude", dirs, (path) => path === join("/b/bin", "claude"));
    expect(found).toBe(join("/b/bin", "claude"));
  });

  test("returns null when no directory contains the command", () => {
    expect(resolveCliFrom("claude", ["/a/bin", "/b/bin"], () => false)).toBeNull();
  });

  test("returns null for an empty directory list", () => {
    expect(resolveCliFrom("claude", [], () => true)).toBeNull();
  });
});

describe("posixUserInstallDirs", () => {
  test.skipIf(process.platform === "win32")("probes the user-owned prefixes a desktop launch cannot see", () => {
    const dirs = posixUserInstallDirs("/home/example");
    expect(dirs).toContain(join("/home/example", ".local", "bin"));
    expect(dirs).toContain(join("/home/example", ".bun", "bin"));
    expect(dirs).toContain(join("/home/example", ".claude", "local"));
  });

  test.skipIf(process.platform !== "win32")("is empty on Windows, where the registry fallback covers the gap", () => {
    expect(posixUserInstallDirs("C:\\Users\\example")).toEqual([]);
  });
});

const USER_PATH_QUERY = [
  "",
  "HKEY_CURRENT_USER\\Environment",
  "    Path    REG_SZ    C:\\Users\\example\\.grok\\bin;C:\\Users\\example\\AppData\\Roaming\\npm",
  "",
].join("\r\n");

const MACHINE_PATH_QUERY = [
  "",
  "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\nodejs",
  "",
].join("\r\n");

describe("parseRegistryPathValue", () => {
  test("keeps spaces and drive colons inside the value", () => {
    expect(parseRegistryPathValue(MACHINE_PATH_QUERY))
      .toBe("%SystemRoot%\\system32;C:\\Program Files\\nodejs");
  });

  test("reads both REG_SZ and REG_EXPAND_SZ", () => {
    expect(parseRegistryPathValue(USER_PATH_QUERY)).toContain(".grok\\bin");
  });

  test("returns empty for output with no Path row", () => {
    expect(parseRegistryPathValue("ERROR: The system was unable to find the specified registry key")).toBe("");
  });
});

describe("expandWindowsEnvRefs", () => {
  test("expands a reference case-insensitively", () => {
    expect(expandWindowsEnvRefs("%systemroot%\\system32", { SystemRoot: "C:\\Windows" }))
      .toBe("C:\\Windows\\system32");
  });

  test("leaves an unresolvable reference verbatim rather than collapsing the entry", () => {
    expect(expandWindowsEnvRefs("%NOPE%\\bin;C:\\real", {})).toBe("%NOPE%\\bin;C:\\real");
  });
});

describe("regExecutable", () => {
  test("prefers the absolute System32 binary over a PATH lookup", () => {
    expect(regExecutable({ SystemRoot: "C:\\Windows" })).toBe(join("C:\\Windows", "System32", "reg.exe"));
  });

  test("falls back to the bare name when no Windows root is named", () => {
    expect(regExecutable({})).toBe("reg");
  });
});

describe("readPersistedWindowsPath", () => {
  test("joins user scope ahead of machine scope and expands references", () => {
    const query = (key: string) => (key.startsWith("HKCU") ? USER_PATH_QUERY : MACHINE_PATH_QUERY);
    const path = readPersistedWindowsPath(query, { SystemRoot: "C:\\Windows" });
    const entries = path.split(";");
    expect(entries[0]).toBe("C:\\Users\\example\\.grok\\bin");
    expect(entries).toContain("C:\\Windows\\system32");
    expect(entries).toContain("C:\\Program Files\\nodejs");
  });

  test("an unreadable hive is skipped, not fatal", () => {
    const query = (key: string) => {
      if (key.startsWith("HKCU")) return USER_PATH_QUERY;
      throw new Error("ERROR: Access is denied.");
    };
    expect(readPersistedWindowsPath(query, {}))
      .toBe("C:\\Users\\example\\.grok\\bin;C:\\Users\\example\\AppData\\Roaming\\npm");
  });

  test("returns empty when nothing is readable, so the caller keeps PATH's answer", () => {
    expect(readPersistedWindowsPath(() => { throw new Error("no reg"); }, {})).toBe("");
  });
});

describe("resolveClaudeCli", () => {
  const npmDir = join("C:", "Users", "example", "AppData", "Roaming", "npm");
  const shim = join(npmDir, "claude.cmd");
  const npmNative = join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const nativeInstall = join("C:", "Users", "example", ".local", "bin", "claude.exe");

  test("an explicit CLAUDE_PATH wins on every platform", () => {
    expect(resolveClaudeCli({ CLAUDE_PATH: "D:/custom/claude.exe" }, "win32", () => shim, () => true))
      .toBe("D:/custom/claude.exe");
    expect(resolveClaudeCli({ CLAUDE_PATH: "/opt/claude" }, "linux", () => "/usr/bin/claude"))
      .toBe("/opt/claude");
  });

  test("on Windows swaps npm's claude.cmd shim for the native binary it wraps", () => {
    expect(resolveClaudeCli({}, "win32", () => shim, (path) => path === npmNative)).toBe(npmNative);
  });

  test("on Windows keeps a native-installer claude.exe as found", () => {
    expect(resolveClaudeCli({}, "win32", () => nativeInstall, () => false)).toBe(nativeInstall);
  });

  test("on Windows keeps a shim with no native binary behind it", () => {
    expect(resolveClaudeCli({}, "win32", () => shim, () => false)).toBe(shim);
  });

  test("on Windows falls back to the bare shim name when nothing resolves", () => {
    expect(resolveClaudeCli({}, "win32", () => null)).toBe("claude.cmd");
  });

  test("elsewhere returns the resolved path or the bare command", () => {
    expect(resolveClaudeCli({}, "linux", () => "/home/example/.local/bin/claude")).toBe("/home/example/.local/bin/claude");
    expect(resolveClaudeCli({}, "darwin", () => null)).toBe("claude");
  });
});

describe("npmShimNativeClaude", () => {
  test("only maps .cmd shims", () => {
    expect(npmShimNativeClaude(join("C:", "bin", "claude.exe"), () => true)).toBeNull();
    expect(npmShimNativeClaude(join("C:", "npm", "CLAUDE.CMD"), () => true))
      .toBe(join("C:", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  });
});
