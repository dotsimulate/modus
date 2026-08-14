import { describe, expect, test } from "bun:test";
import {
  PROVIDER_ORPHAN_IMAGE_NAMES,
  isHarnessOwnedProviderCommand,
} from "../provider-process-identity";

const PORT = 54322;

describe("PROVIDER_ORPHAN_IMAGE_NAMES", () => {
  test("covers the natively compiled CLI as well as the legacy Node host", () => {
    // Claude Code 2.x ships as claude.exe. Scanning node.exe alone reported no
    // orphans on any current install.
    expect(PROVIDER_ORPHAN_IMAGE_NAMES).toContain("node.exe");
    expect(PROVIDER_ORPHAN_IMAGE_NAMES).toContain("claude.exe");
  });
});

describe("isHarnessOwnedProviderCommand", () => {
  test("matches the legacy Node-hosted CLI on either path separator", () => {
    expect(isHarnessOwnedProviderCommand(
      "node.exe C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --print",
      PORT,
    )).toBe(true);
    expect(isHarnessOwnedProviderCommand(
      "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --print",
      PORT,
    )).toBe(true);
  });

  test("matches an inline MCP configuration addressed to this harness", () => {
    const command = '"claude.exe" --output-format stream-json --mcp-config '
      + '"{\\"mcpServers\\":{\\"modus\\":{\\"type\\":\\"http\\",'
      + `\\"url\\":\\"http://127.0.0.1:${PORT}/api/mcp/modus\\"}}}"`;
    expect(isHarnessOwnedProviderCommand(command, PORT)).toBe(true);
  });

  test("ignores a process talking to a different harness port", () => {
    const command = '"claude.exe" --mcp-config "http://127.0.0.1:49999/api/mcp/modus"';
    expect(isHarnessOwnedProviderCommand(command, PORT)).toBe(false);
  });

  test("matches launch material written into a Modus-private temp directory", () => {
    const command = '"claude.exe" --mcp-config '
      + 'C:\\Users\\x\\AppData\\Local\\Temp\\modus-sensitive-a1b2c3\\mcp.json';
    expect(isHarnessOwnedProviderCommand(command, PORT)).toBe(true);
  });

  test("does not claim the Claude Desktop application", () => {
    // These share the claude.exe image name. Reporting one as a stranded
    // session offers the user a control that closes their desktop app.
    const desktop = [
      '"C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\app-1.1.4173\\claude.exe" --startup',
      '"C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\app-1.1.4173\\claude.exe" --type=gpu-process',
      'C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\app-1.1.4173\\claude.exe --type=crashpad-handler',
      '"C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\app-1.1.4173\\claude.exe" '
        + '--type=utility --utility-sub-type=network.mojom.NetworkService',
    ];
    for (const command of desktop) {
      expect(isHarnessOwnedProviderCommand(command, PORT)).toBe(false);
    }
  });

  test("does not claim a CLI the user started themselves", () => {
    const own = '"C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai'
      + '\\claude-code\\bin\\claude.exe" --model claude-opus-5';
    expect(isHarnessOwnedProviderCommand(own, PORT)).toBe(false);
  });
});
