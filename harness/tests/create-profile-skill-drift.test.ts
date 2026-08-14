import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  GlobalConfigSchema,
  ProfileSchema,
  ProfileUiSchema,
  UserProfileSchema,
} from "../profile-schemas";

/**
 * The create-profile skill is what an agent reads before writing someone's
 * profile JSON, so a field missing from it is a field that never gets used and
 * a field invented in it is one that silently does nothing. Zod object schemas
 * here are non-strict — an unknown key validates and is then ignored — so
 * nothing else catches either direction. This test is the only signal.
 *
 * It checks *presence as a documented JSON key* (`"name":`), which is the form
 * the references use, rather than a substring match: a key named in passing
 * inside a comment is not documentation of that field, and the substring form
 * gave false passes for `cwd`, `skills`, and `additionalDirectories`.
 */

/**
 * There are two copies. `.claude/` is what an agent working in this repository
 * reads; `harness/templates/` is what ships and is seeded into a user's own
 * environment. They had already drifted from each other in both directions —
 * the template used the canonical `openai-compat` while `.claude` still said
 * `litellm`, and neither documented the same set of fields — so both are
 * checked rather than assuming one mirrors the other.
 */
const SKILL_DIRS = [
  join(resolveTestSourceDir(import.meta.dir, ".."), "..", ".claude", "skills", "create-profile", "references"),
  join(resolveTestSourceDir(import.meta.dir, ".."), "templates", "skills", "create-profile", "references"),
];

const sources = [
  {
    file: "agent-profile-schema.md",
    schemas: { "ProfileSchema": ProfileSchema, "ProfileUiSchema": ProfileUiSchema },
  },
  {
    file: "user-profile-schema.md",
    schemas: { "UserProfileSchema": UserProfileSchema },
  },
  {
    file: "global-config.md",
    schemas: { "GlobalConfigSchema": GlobalConfigSchema },
  },
];

function documentedKeys(markdown: string): Set<string> {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"\s*:/g)) found.add(match[1]!);
  return found;
}

describe("create-profile skill tracks profile-schemas.ts", () => {
  for (const dir of SKILL_DIRS) {
    const label = dir.includes("templates") ? "templates" : ".claude";

    test(`${label}: the reference directory is where the test thinks it is`, () => {
      // A moved or renamed skill would otherwise make every case below
      // vacuously pass by reading nothing.
      expect(existsSync(dir)).toBe(true);
    });

    for (const { file, schemas } of sources) {
      for (const [schemaName, schema] of Object.entries(schemas)) {
        test(`${label}/${file} documents every ${schemaName} key`, () => {
          const documented = documentedKeys(readFileSync(join(dir, file), "utf8"));
          const declared = Object.keys((schema as { shape: Record<string, unknown> }).shape);
          const undocumented = declared.filter((key) => !documented.has(key)).sort();
          expect({ label, file, schemaName, undocumented })
            .toEqual({ label, file, schemaName, undocumented: [] });
        });
      }
    }
  }
});
