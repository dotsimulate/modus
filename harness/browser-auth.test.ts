import { describe, expect, test } from "bun:test";
import { BrowserSessionStore } from "./browser-auth";

describe("browser session lifecycle", () => {
  test("enforces idle and absolute expiration while allowing bounded activity", () => {
    let sequence = 0;
    const sessions = new BrowserSessionStore(100, 300, () => `token-${++sequence}`);
    const { token, expiresAt } = sessions.mint(1_000);

    expect(expiresAt).toBe(1_300);
    expect(sessions.validate(token, 1_099)).toBe(true);
    expect(sessions.validate(token, 1_198)).toBe(true);
    expect(sessions.validate(token, 1_299)).toBe(false);
    expect(sessions.size).toBe(0);
  });

  test("does not extend the absolute lifetime", () => {
    const sessions = new BrowserSessionStore(100, 250, () => "token");
    sessions.mint(10);
    expect(sessions.validate("token", 100)).toBe(true);
    expect(sessions.validate("token", 190)).toBe(true);
    expect(sessions.validate("token", 259)).toBe(true);
    expect(sessions.validate("token", 260)).toBe(false);
  });

  test("revokes every browser without affecting future sessions", () => {
    let sequence = 0;
    const sessions = new BrowserSessionStore(100, 300, () => `token-${++sequence}`);
    const first = sessions.mint(0).token;
    const second = sessions.mint(0).token;
    sessions.revokeAll();

    expect(sessions.validate(first, 1)).toBe(false);
    expect(sessions.validate(second, 1)).toBe(false);
    expect(sessions.mint(1).token).toBe("token-3");
  });

  test("closes registered live transports when a browser is revoked", () => {
    const revoked: string[][] = [];
    const sessions = new BrowserSessionStore(100, 300, () => "browser-token");
    sessions.onRevoke((tokens) => revoked.push([...tokens]));
    const token = sessions.mint().token;
    let closes = 0;
    sessions.registerConnection(token, () => { closes++; });

    sessions.revokeAll();

    expect(closes).toBe(1);
    expect(revoked).toEqual([["browser-token"]]);
  });
});
