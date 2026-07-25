import { beforeEach, describe, expect, test } from "bun:test";
import {
  setAuthChecker,
  setOriginChecker,
  tryUpgradeTerminalWS,
} from "./terminal-ws";
import { isAllowedBrowserOrigin } from "./security-boundary";

const server = {
  upgrade() {
    throw new Error("upgrade should not be reached for a missing terminal");
  },
};

function authProtocol(token: string): string {
  return `modus-v1, modus-auth.${btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

beforeEach(() => {
  setAuthChecker(() => true);
  setOriginChecker((origin, req) => !origin || isAllowedBrowserOrigin(origin, {
    port: 3777,
    requestHost: req.headers.get("Host"),
  }));
});

describe("terminal WebSocket browser-origin boundary", () => {
  test("rejects a cross-site browser before terminal lookup or upgrade", async () => {
    const response = tryUpgradeTerminalWS(new Request("http://127.0.0.1:3777/ws/terminal/missing", {
      headers: { Origin: "https://evil.example", Host: "127.0.0.1:3777", "Sec-WebSocket-Protocol": authProtocol("test") },
    }), server);

    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("Forbidden origin");
  });

  test("allows the active loopback browser origin to reach terminal lookup", () => {
    const response = tryUpgradeTerminalWS(new Request("http://127.0.0.1:3777/ws/terminal/missing", {
      headers: { Origin: "http://127.0.0.1:3777", Host: "127.0.0.1:3777", "Sec-WebSocket-Protocol": authProtocol("test") },
    }), server);

    expect(response?.status).toBe(404);
  });

  test("preserves non-browser SDK clients that omit Origin", () => {
    const response = tryUpgradeTerminalWS(
      new Request("http://127.0.0.1:3777/ws/terminal/missing", {
        headers: { "Sec-WebSocket-Protocol": authProtocol("test") },
      }),
      server,
    );

    expect(response?.status).toBe(404);
  });

  test("rejects opaque browser origins", () => {
    const response = tryUpgradeTerminalWS(new Request("http://127.0.0.1:3777/ws/terminal/missing", {
      headers: { Origin: "null", Host: "127.0.0.1:3777", "Sec-WebSocket-Protocol": authProtocol("test") },
    }), server);

    expect(response?.status).toBe(403);
  });

  test("does not accept a bearer from the WebSocket URL", async () => {
    setAuthChecker((token) => token === "test");
    const response = tryUpgradeTerminalWS(
      new Request("http://127.0.0.1:3777/ws/terminal/missing?token=test"),
      server,
    );

    expect(response?.status).toBe(401);
    expect(await response?.text()).toBe("Unauthorized");
  });
});
