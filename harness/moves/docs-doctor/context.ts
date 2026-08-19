/**
 * docs-doctor move — check authored content against the live schemas, and the
 * shipped docs against the code they claim to cover.
 *
 * The failure this exists for: prose drifts. A doc can describe a profile field
 * that nothing reads and omit nine fields that are live, and nothing catches it
 * — the Zod object schemas are non-strict, so an unknown key validates cleanly
 * and is then silently ignored at runtime. Every op here
 * reads the schema objects and the docs registry directly, so its answers
 * cannot drift from the code the way documentation can.
 *
 * Handlers are thin wrappers over `profile-schemas.ts` (the Zod definitions the
 * API writes are validated with) and `docs-registry.ts` (the same source the
 * /api/docs routes and the docs widget use). Both are bridged modules — see
 * harness/bridged-modules.ts.
 */

import { existsSync, readFileSync } from "fs";
import { isAbsolute, resolve, sep } from "path";
import type { MoveApiHandler, MoveContext } from "../../move-types";
import { getDoc, listDocs } from "../../docs-registry";
import {
  GlobalConfigSchema,
  ProfileSchema,
  UserProfileSchema,
} from "../../profile-schemas";

type SchemaName = "agent-profile" | "user-profile" | "global-config";

const SCHEMAS: Record<SchemaName, { schema: unknown; label: string; where: string }> = {
  "agent-profile": {
    schema: ProfileSchema,
    label: "ProfileSchema",
    where: "<current-home>/profiles/agents/*.json and <project>/.modus/profiles/agents/*.json",
  },
  "user-profile": {
    schema: UserProfileSchema,
    label: "UserProfileSchema",
    where: "<current-home>/profiles/users/*.json",
  },
  "global-config": {
    schema: GlobalConfigSchema,
    label: "GlobalConfigSchema",
    where: "<current-home>/profiles/_global.json and <project>/.modus/_global.json",
  },
};

/** Source files whose covering docs are cross-checked against a schema. */
const SCHEMA_SOURCE = "harness/profile-schemas.ts";

/**
 * A doc only gets the schema-key cross-check if it already documents most of
 * that schema. Plenty of docs list profile-schemas.ts in `covers:` because they
 * touch one field; telling them they omit the other twenty-seven is noise, and
 * a noisy audit gets ignored. Above this ratio the doc is clearly enumerating
 * the schema, and a gap is worth naming.
 */
const SCHEMA_ENUMERATION_RATIO = 0.5;

function parseSchemaName(value: unknown): SchemaName | null {
  return value === "agent-profile" || value === "user-profile" || value === "global-config"
    ? value
    : null;
}

function shapeOf(schema: unknown): Record<string, unknown> {
  return ((schema as { shape?: Record<string, unknown> }).shape ?? {});
}

/**
 * Best-effort type name. Zod does not promise this introspection surface, so a
 * miss degrades to "unknown" rather than throwing — the key list itself is the
 * part callers depend on.
 */
function typeNameOf(node: unknown): string {
  const zod4 = (node as { _zod?: { def?: { type?: string } } })._zod?.def?.type;
  if (typeof zod4 === "string") return zod4;
  const zod3 = (node as { _def?: { typeName?: string } })._def?.typeName;
  return typeof zod3 === "string" ? zod3 : "unknown";
}

function isOptional(node: unknown): boolean {
  const parser = node as { safeParse?: (value: unknown) => { success: boolean } };
  try {
    return parser.safeParse?.(undefined).success === true;
  } catch {
    return false;
  }
}

function describeKeys(name: SchemaName): string {
  const { schema, label, where } = SCHEMAS[name];
  const shape = shapeOf(schema);
  const lines = [
    `# ${name} (\`${label}\`, harness/profile-schemas.ts)`,
    `Lives in: ${where}`,
    "",
    `${Object.keys(shape).length} accepted keys:`,
    "",
  ];
  for (const [key, node] of Object.entries(shape)) {
    lines.push(`- \`${key}\` — ${typeNameOf(node)}${isOptional(node) ? " (optional)" : " (required)"}`);
  }
  lines.push(
    "",
    "Unknown keys are NOT rejected by this schema — they validate and are then",
    "ignored at runtime. Use `validate` to be told about them explicitly.",
  );
  return lines.join("\n");
}

/** Resolve a caller-supplied path, refusing anything outside the project cwd. */
function resolveInCwd(cwd: string, candidate: string): string | null {
  const root = resolve(cwd);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  return target === root || target.startsWith(root + sep) ? target : null;
}

function formatIssues(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string; code: string }> } }): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.map(String).join(".") : "(root)";
    return `- \`${where}\` — ${issue.message} [${issue.code}]`;
  });
}

export async function gather(ctx: MoveContext): Promise<string> {
  const target = typeof ctx.inputs.target === "string" ? ctx.inputs.target.trim() : "";

  const lines = [
    "You are inside the `docs-doctor` move. You can check authored Modus content",
    "against the live Zod schemas, and check the shipped documentation against the",
    "source it claims to cover.",
    "",
    // The harness appends the token and the full modus_submit protocol below
    // this text (see buildApiOpsProtocol in move-runner.ts).
    "## What each op is for",
    "",
    "- `schema_keys` — the keys a schema actually accepts. Read this before you",
    "  state or write any profile field. Prose docs drift; this cannot.",
    "- `validate` — validate a profile or config, by inline `content` or by `path`",
    "  relative to this project. It reports **unknown keys** as well as schema",
    "  errors, which matters because the schemas accept unknown keys silently and",
    "  the runtime then ignores them. A field that \"validates\" may do nothing.",
    "- `doc_drift` — audit docs against their `covers:` frontmatter: source files",
    "  that no longer exist, and live schema keys the covering doc never mentions.",
    "  A doc that documents a pattern rather than code declares `covers: none`,",
    "  which is treated as answered — do not \"fix\" those by inventing paths.",
    "",
    "## How to work",
    "",
    "1. Check before you assert. If a question is about which fields exist, call",
    "   `schema_keys` rather than quoting a doc.",
    "2. When validating authored content, report unknown keys as findings, not",
    "   footnotes — they are the failure mode that looks like success.",
    "3. When reporting doc drift, name the doc id and the specific keys, and say",
    "   plainly that a missing mention is a signal to read, not proof of a bug:",
    "   a key may be intentionally undocumented.",
    "4. This move only reads. Any fix belongs in the file the user asks you to",
    `   change — project content under \`${"<project>/.modus/"}\`, not the Modus source,`,
    "   unless the user has explicitly asked for a core contribution.",
  ];

  if (target) {
    lines.push("", "## What the user asked to check", "", target);
  } else {
    lines.push(
      "",
      "No target was given. Offer a full sweep: `doc_drift` with no docId, plus",
      "`schema_keys` for anything the user is about to author.",
    );
  }

  return lines.join("\n");
}

export const handlers: Record<string, MoveApiHandler> = {
  schema_keys: async (_ctx, data) => {
    const name = parseSchemaName(data.schema);
    if (!name) {
      return { ok: false, error: `schema must be one of: ${Object.keys(SCHEMAS).join(", ")}` };
    }
    return { ok: true, message: describeKeys(name) };
  },

  validate: async (ctx, data) => {
    const name = parseSchemaName(data.schema);
    if (!name) {
      return { ok: false, error: `schema must be one of: ${Object.keys(SCHEMAS).join(", ")}` };
    }

    let value: unknown;
    let origin: string;
    if (typeof data.path === "string" && data.path.trim()) {
      const target = resolveInCwd(ctx.cwd, data.path.trim());
      if (!target) return { ok: false, error: "path must stay inside the project directory" };
      if (!existsSync(target)) return { ok: false, error: `no such file: ${data.path}` };
      try {
        value = JSON.parse(readFileSync(target, "utf-8"));
      } catch (error) {
        return { ok: false, error: `${data.path} is not valid JSON: ${(error as Error).message}` };
      }
      origin = String(data.path);
    } else if (data.content && typeof data.content === "object") {
      value = data.content;
      origin = "inline content";
    } else {
      return { ok: false, error: "pass either `content` (an object) or `path` (a JSON file)" };
    }

    const { schema, label } = SCHEMAS[name];
    const result = (schema as { safeParse: (v: unknown) => any }).safeParse(value);
    const issues = formatIssues(result);

    const known = new Set(Object.keys(shapeOf(schema)));
    const unknown = value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).filter((key) => !known.has(key))
      : [];

    const lines = [`# ${origin} against \`${label}\``, ""];
    if (issues.length) {
      lines.push(`## ${issues.length} schema error(s)`, "", ...issues, "");
    } else {
      lines.push("## Schema: valid", "");
    }
    if (unknown.length) {
      lines.push(
        `## ${unknown.length} unknown key(s) — accepted but ignored`,
        "",
        ...unknown.map((key) => `- \`${key}\` — not in ${label}; nothing reads it`),
        "",
        "These do not fail validation. They also do nothing. Treat them as findings.",
      );
    } else {
      lines.push("## Unknown keys: none");
    }
    return { ok: issues.length === 0, message: lines.join("\n").trimEnd() };
  },

  doc_drift: async (ctx, data) => {
    const only = typeof data.docId === "string" && data.docId.trim() ? data.docId.trim() : null;
    const entries = listDocs({ audience: "all", cwd: ctx.cwd })
      .filter((entry) => !entry.generated && (!only || entry.id === only));
    if (!entries.length) {
      return { ok: false, error: only ? `unknown doc id: ${only}` : "no docs found" };
    }

    // covers: paths are declared relative to the repository root. In an
    // installed build that tree is absent, so a missing file is only reported
    // when at least one covered path does resolve — otherwise every doc would
    // look broken.
    const root = resolve(ctx.cwd);
    const resolvable = entries.some((entry) => (entry.covers ?? []).some((path) => existsSync(resolve(root, path))));

    const lines: string[] = [];
    let findings = 0;

    for (const entry of entries) {
      const doc = getDoc(entry.id, { cwd: ctx.cwd });
      if (!doc) continue;
      const covers = entry.covers ?? [];
      const docLines: string[] = [];

      if (entry.coversNone) {
        // `covers: none` is an explicit statement that the doc describes a
        // pattern or a procedure, not code. There is nothing to verify, and
        // repeating that every run is exactly the noise this tool avoids.
      } else if (!covers.length) {
        docLines.push("- no `covers:` frontmatter — nothing to check it against");
      } else if (resolvable) {
        for (const path of covers) {
          // `.modus/…` paths are per-project and created at runtime; their
          // absence from a source checkout says nothing.
          if (path.startsWith(".modus/")) continue;
          // A glob is checked by its containing directory — the literal string
          // will never exist and reporting it every run trains people to ignore
          // this output.
          const probe = path.includes("*") ? path.slice(0, path.lastIndexOf("/") + 1) : path;
          if (!probe || !existsSync(resolve(root, probe))) {
            docLines.push(`- covers \`${path}\`, which does not exist`);
          }
        }
      }

      // Deliberately no mtime-vs-lastUpdated check: in a fresh checkout every
      // file is newer than every doc, so it fires on everything and means
      // nothing. Only claims that can be proven wrong are reported.

      if (covers.includes(SCHEMA_SOURCE)) {
        for (const [name, { schema, label }] of Object.entries(SCHEMAS)) {
          const keys = Object.keys(shapeOf(schema));
          const missing = keys.filter((key) => !doc.content.includes(key));
          const documented = (keys.length - missing.length) / (keys.length || 1);
          if (missing.length && documented >= SCHEMA_ENUMERATION_RATIO) {
            docLines.push(
              `- ${label} (${name}): documents ${keys.length - missing.length}/${keys.length} keys, missing ${missing.map((k) => `\`${k}\``).join(", ")}`,
            );
          }
        }
      }

      if (docLines.length) {
        findings += docLines.length;
        lines.push(`## \`${entry.id}\` — ${entry.title}`, ...docLines, "");
      }
    }

    if (!findings) {
      return { ok: true, message: `Checked ${entries.length} doc(s). No drift found.` };
    }
    return {
      ok: true,
      message: [
        `Checked ${entries.length} doc(s); ${findings} finding(s).`,
        "",
        ...lines,
        "A key that is never mentioned is a prompt to read the doc, not proof of a",
        "bug — some keys are deliberately undocumented. A missing covered file is.",
      ].join("\n").trimEnd(),
    };
  },
};
