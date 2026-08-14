/**
 * docs-doctor handler tests — isolated temp fixtures only. No live home, DB,
 * ports, or the user's real Modus tree. The docs-registry ops are exercised
 * against the shipped docs the harness already reads read-only.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { MoveApiContext } from "../../../move-types";
import { handlers } from "../../../moves/docs-doctor/context";

let cwd: string;

function ctx(): MoveApiContext {
  return { cwd } as MoveApiContext;
}

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "modus-docs-doctor-"));
  mkdirSync(join(cwd, "profiles"), { recursive: true });
  writeFileSync(join(cwd, "profiles", "good.json"), JSON.stringify({
    prompt: "You are a reviewer.",
    description: "Reviews code.",
    provider: "claude-code",
  }));
  writeFileSync(join(cwd, "profiles", "drifted.json"), JSON.stringify({
    prompt: "You are a reviewer.",
    description: "Reviews code.",
    // Plausible-looking and definitely not in ProfileSchema. (`skills` used to
    // play this role, but it became a real field once attachment landed.)
    temperature: 0.7,
  }));
  writeFileSync(join(cwd, "profiles", "broken.json"), "{ not json");
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("schema_keys", () => {
  test("reports live keys rather than documented ones", async () => {
    const result = await handlers.schema_keys!(ctx(), { schema: "agent-profile" });
    expect(result.ok).toBe(true);
    // Keys the field report found missing from prose but live in the schema.
    for (const key of ["disallowedTools", "moves", "skills", "env", "plugins", "claudeMdExcludes",
      "maxBudgetUsd", "codexSandboxMode", "codexRules", "cwdSuggestions"]) {
      expect(result.message).toContain(`\`${key}\``);
    }
    // ...and not a key that merely looks like it belongs.
    expect(result.message).not.toContain("`temperature`");
    expect(result.message).toContain("`prompt` — string (required)");
    expect(result.message).toContain("`cwd` — optional (optional)");
  });

  test("rejects an unknown schema name instead of guessing", async () => {
    const result = await handlers.schema_keys!(ctx(), { schema: "move" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("agent-profile");
  });
});

describe("validate", () => {
  test("accepts a well-formed profile", async () => {
    const result = await handlers.validate!(ctx(), {
      schema: "agent-profile",
      path: "profiles/good.json",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Schema: valid");
    expect(result.message).toContain("Unknown keys: none");
  });

  test("surfaces an unknown key that the schema itself accepts silently", async () => {
    // This is the whole point of the move: an unknown key passes safeParse and
    // is then ignored at runtime, so validation alone reports success.
    const result = await handlers.validate!(ctx(), {
      schema: "agent-profile",
      path: "profiles/drifted.json",
    });
    expect(result.message).toContain("Schema: valid");
    expect(result.message).toContain("`temperature`");
    expect(result.message).toContain("nothing reads it");
  });

  test("reports schema errors with their paths", async () => {
    const result = await handlers.validate!(ctx(), {
      schema: "agent-profile",
      content: { prompt: "p", description: "d", provider: "not-a-provider" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("`provider`");
    expect(result.message).toContain("unknown provider");
  });

  test("refuses a path outside the project", async () => {
    const result = await handlers.validate!(ctx(), {
      schema: "agent-profile",
      path: "../../../etc/passwd",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("inside the project directory");
  });

  test("reports unreadable JSON instead of throwing", async () => {
    const result = await handlers.validate!(ctx(), {
      schema: "agent-profile",
      path: "profiles/broken.json",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });

  test("requires content or path", async () => {
    const result = await handlers.validate!(ctx(), { schema: "agent-profile" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("`content`");
  });
});

describe("doc_drift", () => {
  test("rejects an unknown doc id", async () => {
    const result = await handlers.doc_drift!(ctx(), { docId: "no-such-doc" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no-such-doc");
  });

  test("sweeps every doc and always reports how many it checked", async () => {
    const result = await handlers.doc_drift!(ctx(), {});
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Checked \d+ doc\(s\)/);
  });

  test("does not report drift it cannot substantiate from the given cwd", async () => {
    // The fixture cwd contains none of the covered source, so every covers
    // path would 'not exist'. Reporting that would make the sweep useless
    // anywhere but a source checkout.
    const result = await handlers.doc_drift!(ctx(), {});
    expect(result.message).not.toContain("which does not exist");
    // mtime is not a drift signal either: in a fresh checkout every file is
    // newer than every doc, so it would fire on everything.
    expect(result.message).not.toContain("changed after lastUpdated");
  });

  test("only cross-checks schema keys against docs that enumerate the schema", async () => {
    // A doc that merely touches one profile field must not be told it omits
    // the other twenty-seven — a noisy audit gets ignored.
    const result = await handlers.doc_drift!(ctx(), {});
    const reported = [...result.message!.matchAll(/documents (\d+)\/(\d+) keys/g)];
    for (const [, documented, total] of reported) {
      expect(Number(documented) / Number(total)).toBeGreaterThanOrEqual(0.5);
    }
  });
});
