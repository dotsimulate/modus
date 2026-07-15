import { describe, expect, test } from "bun:test";
import {
  canAdoptLegacyRule,
  classifyHttps443,
  ownershipFor,
  tailscaleServeOffArgs,
  tailscaleServeOnArgs,
} from "./tailscale-serve";

function config(proxy = "http://127.0.0.1:3777"): string {
  return JSON.stringify({
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      "host.example.ts.net:443": { Handlers: { "/": { Proxy: proxy } } },
      "host.example.ts.net:8443": { Handlers: { "/": { Proxy: "https+insecure://localhost:8443" } } },
    },
  });
}

describe("Tailscale Serve ownership", () => {
  const owner = ownershipFor("host.example.ts.net", 3777, new Date(0));

  test("recognizes only the exact recorded endpoint and preserves unrelated ports", () => {
    expect(classifyHttps443(config(), owner)).toBe("modus");
    expect(classifyHttps443(config("http://127.0.0.1:3778"), owner)).toBe("foreign");
    expect(classifyHttps443(config(), null)).toBe("foreign");
  });

  test("never claims funnel or non-Modus targets", () => {
    const funnel = JSON.stringify({
      Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3777" } } } },
      AllowFunnel: { "host.example.ts.net:443": true },
    });
    expect(classifyHttps443(funnel, owner)).toBe("foreign");
    expect(classifyHttps443(config("http://127.0.0.1:9999"), owner)).toBe("foreign");
    expect(classifyHttps443("not-json", owner)).toBe("foreign");
  });

  test("adopts only a persisted legacy rule on the requested Modus port", () => {
    expect(canAdoptLegacyRule(config(), 3777, true, 3777, 5)).toBe(true);
    expect(canAdoptLegacyRule(config(), 3778, true, 3777, 5)).toBe(false);
    expect(canAdoptLegacyRule(config(), 3777, false, 3777, 5)).toBe(false);
  });

  test("uses identical non-shell argv on Windows, Linux, and macOS", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      expect({ platform, argv: tailscaleServeOnArgs(3777) }.argv).toEqual(["serve", "--bg", "--yes", "3777"]);
      expect({ platform, argv: tailscaleServeOffArgs() }.argv).toEqual(["serve", "--https=443", "off"]);
    }
  });
});
