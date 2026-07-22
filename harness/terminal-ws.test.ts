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

beforeEach(() => {
  setAuthChecker(() => true);
  setOriginChecker((origin, req) => !origin || isAllowedBrowserOrigin(origin, {
    port: 3777,
    requestHost: req.headers.get("Host"),
  }));
});

describe("terminal WebSocket browser-origin boundary", () => {
  test("rejects a cross-site browser before terminal lookup or upgrade", async () => {
    const response = tryUpgradeTerminalWS(new Request("http://127.0.0.1:3777/ws/terminal/missing?token=test", {
      headers: { Origin: "https://evil.example", Host: "127.0.0.1:3777" },
    }), server);

    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("Forbidden origin");
  });

  test("allows the active loopback browser origin to reach terminal lookup", () => {
    const response = tryUpgradeTerminalWS(new Request("http://127.0.0.1:3777/ws/terminal/missing?token=test", {
      headers: { Origin: "http://127.0.0.1:3777", Host: "127.0.0.1:3777" },
    }), server);

    expect(response?.status).toBe(404);
  });

  test("preserves non-browser SDK clients that omit Origin", () => {
    const response = tryUpgradeTerminalWS(
      new Request("http://127.0.0.1:3777/ws/terminal/missing?token=test"),
      server,
    );

    expect(response?.status).toBe(404);
  });

  test("rejects opaque browser origins", () => {
    const response = tryUpgradeTerminalWS(new Request("http://127.0.0.1:3777/ws/terminal/missing?token=test", {
      headers: { Origin: "null", Host: "127.0.0.1:3777" },
    }), server);

    expect(response?.status).toBe(403);
  });
});
