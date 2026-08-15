import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  clearFileTickets,
  isFileTicket,
  mintFileTicket,
  validateFileTicket,
} from "../file-ticket";
import { buildRawFileUrl } from "../ui/src/rawFileUrl";

afterEach(() => clearFileTickets());

const file = join("D:", "project", "notes.md");
const other = join("D:", "project", "secrets.env");

describe("file tickets", () => {
  test("authorize the exact file they were minted for", () => {
    const ticket = mintFileTicket(file);
    expect(isFileTicket(ticket)).toBe(true);
    expect(validateFileTicket(ticket, file)).toBe(true);
  });

  // The whole reason the route stopped accepting a query credential: a URL that
  // escapes into history or a chat log must not read anything else.
  test("do not authorize any other file", () => {
    const ticket = mintFileTicket(file);
    expect(validateFileTicket(ticket, other)).toBe(false);
    expect(validateFileTicket(ticket, join("D:", "project", "..", "project", "secrets.env"))).toBe(false);
  });

  test("compare resolved paths, so a different spelling of the same file still works", () => {
    const ticket = mintFileTicket(file);
    expect(validateFileTicket(ticket, join("D:", "project", "sub", "..", "notes.md"))).toBe(true);
  });

  test("expire", () => {
    const now = 1_000_000;
    const ticket = mintFileTicket(file, now, 60_000);
    expect(validateFileTicket(ticket, file, now + 59_999)).toBe(true);
    expect(validateFileTicket(ticket, file, now + 60_000)).toBe(false);
    // Expiry is permanent — a later check cannot resurrect it.
    expect(validateFileTicket(ticket, file, now + 1)).toBe(false);
  });

  test("an unknown ticket authorizes nothing", () => {
    expect(validateFileTicket("ft-nonsense", file)).toBe(false);
    expect(validateFileTicket("", file)).toBe(false);
  });

  test("are reusable within their window, because a browser re-requests images", () => {
    const ticket = mintFileTicket(file);
    expect(validateFileTicket(ticket, file)).toBe(true);
    expect(validateFileTicket(ticket, file)).toBe(true);
  });

  test("each mint is distinct", () => {
    expect(mintFileTicket(file)).not.toBe(mintFileTicket(file));
  });
});

// Importing index.ts starts a server, so the route policy is pinned by reading
// the source of the one function that decides it.
describe("query-credential policy", () => {
  const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8");

  function functionBody(name: string): string {
    const start = source.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nfunction ", start + 1);
    return source.slice(start, end === -1 ? source.length : end);
  }

  test("raw file reads are not in the query-credential allowlist", () => {
    const body = functionBody("allowsQueryCredential");
    // Any quoted form of the route, not one exact comparison — an earlier
    // version of this guard matched `path === "..."` and a `==` re-added the
    // route straight past it. The comment above it uses backticks, so the prose
    // explaining the exclusion stays legal.
    expect(body).not.toContain('"/api/file/raw"');
    expect(body).not.toContain("'/api/file/raw'");
    // The routes that genuinely need it are unaffected.
    expect(body).toContain('path === "/api/events/sessions"');
    expect(body).toContain("\\/api\\/preview\\/file\\/");
  });

  test("the ticket check is the last thing the auth middleware tries", () => {
    const middleware = source.slice(source.indexOf('app.use("/api/*"'));
    const operator = middleware.indexOf("operatorKind(c, allowsQueryCredential(c))");
    const ticket = middleware.indexOf("validFileTicketRequest(c)");
    expect(operator).toBeGreaterThan(-1);
    expect(ticket).toBeGreaterThan(operator);
  });
});

describe("raw file url", () => {
  test("carries the ticket and never a bearer token", () => {
    const url = buildRawFileUrl("http://127.0.0.1:4200", file, "ft-abc");
    expect(url).toContain("ticket=ft-abc");
    expect(url).toContain(`path=${encodeURIComponent(file)}`);
    expect(url).not.toContain("token=");
  });

  test("encodes a path containing query characters", () => {
    const url = buildRawFileUrl("", "/tmp/a b&c=d.txt", "ft-abc");
    expect(url).toBe("/api/file/raw?path=%2Ftmp%2Fa%20b%26c%3Dd.txt&ticket=ft-abc");
  });
});
