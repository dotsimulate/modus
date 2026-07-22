import { describe, expect, test } from "bun:test";
import {
  PinAttemptThrottle,
  isAllowedBrowserOrigin,
  requestSourceKey,
} from "./security-boundary";

describe("browser origin boundary", () => {
  const base = { port: 3777, requestHost: "modus-host.example.ts.net" };

  test("allows loopback UI/dev and the active Tailscale host", () => {
    expect(isAllowedBrowserOrigin("http://localhost:3777", base)).toBe(true);
    expect(isAllowedBrowserOrigin("http://127.0.0.1:5173", base)).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:5180", base)).toBe(true);
    expect(isAllowedBrowserOrigin("https://modus-host.example.ts.net", base)).toBe(true);
  });

  test("allows only the exact local Tauri application origins", () => {
    expect(isAllowedBrowserOrigin("http://tauri.localhost", base)).toBe(true);
    expect(isAllowedBrowserOrigin("https://tauri.localhost", base)).toBe(true);
    expect(isAllowedBrowserOrigin("tauri://localhost", base)).toBe(true);
    expect(isAllowedBrowserOrigin("http://evil.tauri.localhost", base)).toBe(false);
  });

  test("rejects foreign, malformed, and mismatched Tailscale origins", () => {
    expect(isAllowedBrowserOrigin("https://evil.example", base)).toBe(false);
    expect(isAllowedBrowserOrigin("https://other.example.ts.net", base)).toBe(false);
    expect(isAllowedBrowserOrigin("null", base)).toBe(false);
  });

  test("allows exact configured additions", () => {
    expect(isAllowedBrowserOrigin("https://modus.example.com", {
      ...base,
      configuredOrigins: "https://modus.example.com",
    })).toBe(true);
  });
});

describe("PIN throttling", () => {
  test("blocks the fifth failure for fifteen minutes and success clears a client", () => {
    const throttle = new PinAttemptThrottle(5, 300_000, 900_000, 50);
    for (let i = 0; i < 4; i++) expect(throttle.recordFailure("client", i).allowed).toBe(true);
    expect(throttle.recordFailure("client", 4)).toEqual({ allowed: false, retryAfterSeconds: 900 });
    expect(throttle.check("client", 10).allowed).toBe(false);
    throttle.recordSuccess("client");
    expect(throttle.check("client", 10).allowed).toBe(true);
  });

  test("uses forwarded client identity only behind a loopback proxy", () => {
    expect(requestSourceKey("127.0.0.1", "100.64.0.2, 127.0.0.1")).toBe("100.64.0.2");
    expect(requestSourceKey("192.168.1.4", "spoofed")).toBe("192.168.1.4");
  });

  test("does not retain unseen sources and prunes expired unique-source failures", () => {
    const throttle = new PinAttemptThrottle(5, 100, 200, 10);
    for (let i = 0; i < 1_000; i++) throttle.check(`unseen-${i}`, 0);
    expect((throttle as any).sources.size).toBe(0);

    for (let i = 0; i < 10; i++) throttle.recordFailure(`failed-${i}`, i);
    expect((throttle as any).sources.size).toBe(10);
    throttle.check("fresh", 500);
    expect((throttle as any).sources.size).toBe(0);
  });
});
