/**
 * modus-brain move — interactive Modus knowledge for the current agent.
 *
 * gather() injects the compact documentation index plus an op contract, so the
 * agent can search and read the core docs through modus_submit on any provider.
 * The disposition is two-mode: answer questions from the docs (help mode), or
 * refine a request into Modus-native primitives and build them (build mode).
 *
 * Handlers are thin wrappers over the docs registry (docs-registry.ts) — the
 * same source the /api/docs routes and the docs widget use.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { MoveApiHandler, MoveContext } from "../../move-types";
import { getDoc, listDocs, searchDocs, type DocAudience } from "../../docs-registry";
import { MODUS_HOME } from "../../modus-home";

const INDEX_SUMMARY_MAX = 110;

// ── Feedback zone ──
// A standing channel for the agent to report back on using Modus itself: doc
// gaps, rough edges in a primitive, capabilities that turned out not to exist,
// behavior that contradicted the contract.
//
// The handler owns the write on purpose. An entry is a structured submission
// with a validated shape — kind and primitive normalized to their enums, doc id
// checked against the live registry, timestamp stamped server-side. Left to
// freehand agent writes the log drifts into inconsistent prose and stops being
// queryable, which is the whole value of it.
//
// Append-only, one fixed path, no overwrite and no delete. Lives in the Modus
// home rather than a project because the subject is the harness: the same rough
// edge hit from two projects is one piece of feedback.

const FEEDBACK_KINDS = ["docs", "friction", "missing", "wrong"] as const;
type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

const PRIMITIVES = [
  "move", "action", "page", "profile", "mission",
  "plugin", "skill", "provider", "docs", "other",
] as const;
type Primitive = (typeof PRIMITIVES)[number];

type Feedback = {
  ts: string;
  kind: FeedbackKind;
  what: string;
  friction: string;
  primitive?: Primitive;
  doc?: string;
  queries?: string[];
  resolvedBy?: string;
  cwd?: string;
};

function feedbackPath(): string {
  return join(MODUS_HOME, "modus-feedback.jsonl");
}

function parseKind(value: unknown): FeedbackKind | undefined {
  return FEEDBACK_KINDS.includes(value as FeedbackKind) ? (value as FeedbackKind) : undefined;
}

function parsePrimitive(value: unknown): Primitive | undefined {
  return PRIMITIVES.includes(value as Primitive) ? (value as Primitive) : undefined;
}

function appendFeedback(entry: Feedback): void {
  const path = feedbackPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

function readFeedback(): Feedback[] {
  const path = feedbackPath();
  if (!existsSync(path)) return [];
  const out: Feedback[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Feedback);
    } catch {
      // A corrupt line should not blind the reader to the rest of the log.
    }
  }
  return out;
}

function formatFeedback(entry: Feedback): string {
  const tag = entry.primitive ? `${entry.kind}/${entry.primitive}` : entry.kind;
  const lines = [
    `- [${tag}] ${entry.what}`,
    `    friction: ${entry.friction}`,
  ];
  if (entry.doc) lines.push(`    doc: \`${entry.doc}\``);
  if (entry.queries?.length) lines.push(`    tried: ${entry.queries.map((q) => `"${q}"`).join(", ")}`);
  if (entry.resolvedBy) lines.push(`    got past it by: ${entry.resolvedBy}`);
  lines.push(`    filed: ${entry.ts}`);
  return lines.join("\n");
}

function formatIndex(cwd: string | undefined, audience?: DocAudience | "all"): string {
  const entries = listDocs({ audience: audience ?? "all", cwd });
  const lines = entries.map((e) => {
    const summary = e.summary.length > INDEX_SUMMARY_MAX
      ? `${e.summary.slice(0, INDEX_SUMMARY_MAX - 3)}...`
      : e.summary;
    return `- \`${e.id}\` [${e.audience}] ${e.title}${summary ? ` — ${summary}` : ""}`;
  });
  return lines.join("\n");
}

function parseAudience(value: unknown): DocAudience | "all" | undefined {
  return value === "user" || value === "dev" || value === "agent" || value === "all"
    ? value
    : undefined;
}

export async function gather(ctx: MoveContext): Promise<string> {
  const request = typeof ctx.inputs.request === "string" ? ctx.inputs.request.trim() : "";

  const lines = [
    "You are inside the `modus-brain` move. You have interactive access to the",
    "documentation of Modus, the agent harness this session is running in.",
    "",
    // The harness appends the token and the full modus_submit protocol below
    // this text (see buildApiOpsProtocol in move-runner.ts) — it owns that
    // contract, so only usage guidance belongs here.
    "## Ops",
    "",
    "`docs_search` takes a batch: send several queries in one call rather than",
    "one at a time. `docs_get` fetches a whole document by id. `docs_list`",
    "re-lists the index, optionally narrowed by audience.",
    "",
    "`feedback` files a report on Modus itself. `feedback_list` reads what has",
    "already been filed.",
    "",
    "## The feedback zone — this part is required",
    "",
    "Modus is under active development and you are one of the few things that",
    "actually exercises its primitives end to end. **Reporting back is part of the",
    "job, not an optional courtesy.** Working around a rough edge silently is the",
    "one outcome to avoid — it means the same edge is still there next time.",
    "",
    "File with `feedback` whenever, during this session, you hit any of:",
    "",
    "- **`docs`** — you searched and the answer was not there, or was too vague to",
    "  act on, or was stale.",
    "- **`friction`** — it works, but authoring or using it was awkward, verbose,",
    "  repetitive, or surprising. This one gets underreported. File it anyway.",
    "- **`missing`** — you wanted a capability and it does not exist, so you had to",
    "  compose around it.",
    "- **`wrong`** — behavior contradicted the documentation or the stated",
    "  contract. Always file these; they are the highest-value entries.",
    "",
    "Rules for a useful entry:",
    "",
    "- Be concrete. Name the field, op, file, or behavior. \"The moves doc is thin\"",
    "  is not actionable; \"`api.state.persist` is documented but nothing says where",
    "  the state file lands\" is.",
    "- Put how you got past it in `resolvedBy` — read source, trial and error, gave",
    "  up. The fix gets written from that.",
    "- One call per distinct issue. Do not batch unrelated things into one entry.",
    "- Check `feedback_list` first if you are filing several, so you sharpen an",
    "  existing entry rather than restating it.",
    "",
    "Before you finish a build-mode task, either file what you hit or state plainly",
    "that nothing was rough. Silence is not a valid answer.",
    "",
    "## Documentation index",
    "",
    formatIndex(ctx.cwd),
    "",
    "## How to work",
    "",
    "1. Start from `capability-surface` (the condensed agent-grade reference) and",
    "   batch-search anything else you need. Do not guess Modus behavior — verify",
    "   against the docs before stating or building.",
    "2. If the request is a question, answer it from the docs (help mode). Cite doc",
    "   ids so the user can read more in the app's docs page.",
    "3. If the request is something to build, first refine it into Modus-native",
    "   primitives — decide whether it is a move, action, page, agent profile, or a",
    "   composition (e.g. profile + persistent move) — state that shape briefly,",
    "   then build it under this project's `.modus/` directory (build mode).",
    "4. Project-authored content belongs in `<project>/.modus/`; never edit the",
    "   Modus application source for ordinary use.",
  ];

  if (request) {
    lines.push("", "## The user's request", "", request);
  } else {
    lines.push("", "No request was provided — ask the user what they want to do or understand.");
  }

  return lines.join("\n");
}

export const handlers: Record<string, MoveApiHandler> = {
  docs_list: async (ctx, data) => {
    const audience = parseAudience(data.audience);
    return { ok: true, message: formatIndex(ctx.cwd, audience) };
  },

  docs_search: async (ctx, data) => {
    const queries = Array.isArray(data.queries)
      ? data.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : [];
    if (!queries.length) {
      return { ok: false, error: "queries must be a non-empty array of strings" };
    }
    const limit = typeof data.limit === "number" ? data.limit : undefined;
    const resultSets = searchDocs(queries, { limit, cwd: ctx.cwd });
    const lines: string[] = [];
    for (const set of resultSets) {
      lines.push(`## results for "${set.query}"`);
      if (!set.results.length) {
        lines.push("(no matches)", "");
        continue;
      }
      for (const hit of set.results) {
        lines.push(`- \`${hit.id}\` — ${hit.title} (score ${hit.score})`);
        for (const snippet of hit.snippets) {
          lines.push(`    L${snippet.line}: ${snippet.text}`);
        }
      }
      lines.push("");
    }
    return { ok: true, message: lines.join("\n").trimEnd() };
  },

  docs_get: async (ctx, data) => {
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) return { ok: false, error: "id is required" };
    const doc = getDoc(id, { cwd: ctx.cwd });
    if (!doc) return { ok: false, error: `unknown doc id: ${id} (use docs_list for valid ids)` };
    return { ok: true, message: `# ${doc.title} (\`${doc.id}\`)\n\n${doc.content}` };
  },

  feedback: async (ctx, data) => {
    const kind = parseKind(data.kind);
    const what = typeof data.what === "string" ? data.what.trim() : "";
    const friction = typeof data.friction === "string" ? data.friction.trim() : "";

    if (!kind) {
      return { ok: false, error: `kind is required — one of: ${FEEDBACK_KINDS.join(", ")}` };
    }
    if (!what) return { ok: false, error: "what is required — what were you trying to do?" };
    if (!friction) return { ok: false, error: "friction is required — what actually got in the way?" };

    const doc = typeof data.doc === "string" && data.doc.trim() ? data.doc.trim() : undefined;
    if (doc && !getDoc(doc, { cwd: ctx.cwd })) {
      return { ok: false, error: `unknown doc id: ${doc} (use docs_list for valid ids, or omit doc)` };
    }

    const queries = Array.isArray(data.queries)
      ? data.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : undefined;
    const resolvedBy = typeof data.resolvedBy === "string" && data.resolvedBy.trim()
      ? data.resolvedBy.trim()
      : undefined;

    const entry: Feedback = {
      ts: new Date().toISOString(),
      kind,
      what,
      friction,
      ...(parsePrimitive(data.primitive) ? { primitive: parsePrimitive(data.primitive) } : {}),
      ...(doc ? { doc } : {}),
      ...(queries?.length ? { queries } : {}),
      ...(resolvedBy ? { resolvedBy } : {}),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    };

    try {
      appendFeedback(entry);
    } catch (err: any) {
      return { ok: false, error: `could not record the feedback: ${err?.message ?? String(err)}` };
    }

    return {
      ok: true,
      message: [
        `Filed [${entry.kind}${entry.primitive ? `/${entry.primitive}` : ""}].`,
        "Carry on with the task. Say what you concluded and how you established it,",
        "so the reader knows which parts did not come from the documentation.",
      ].join("\n"),
    };
  },

  feedback_list: async (_ctx, data) => {
    const limit = typeof data.limit === "number" && data.limit > 0 ? Math.floor(data.limit) : 50;
    const kindFilter = parseKind(data.kind);
    const primitiveFilter = parsePrimitive(data.primitive);

    let entries = readFeedback();
    if (kindFilter) entries = entries.filter((e) => e.kind === kindFilter);
    if (primitiveFilter) entries = entries.filter((e) => e.primitive === primitiveFilter);

    if (!entries.length) {
      const scope = kindFilter || primitiveFilter ? " matching that filter" : "";
      return { ok: true, message: `No feedback filed${scope}.` };
    }

    const recent = entries.slice(-limit).reverse();
    const header = `${entries.length} entr${entries.length === 1 ? "y" : "ies"} filed`
      + (recent.length < entries.length ? `, showing ${recent.length} most recent` : "");
    return { ok: true, message: [header, "", ...recent.map(formatFeedback)].join("\n") };
  },
};
