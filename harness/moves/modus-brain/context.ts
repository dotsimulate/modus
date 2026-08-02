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

export const FEEDBACK_KINDS = ["docs", "friction", "missing", "wrong"] as const;
type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const PRIMITIVES = [
  "move", "action", "page", "profile", "mission",
  "plugin", "skill", "provider", "client", "docs", "other",
] as const;
type Primitive = (typeof PRIMITIVES)[number];

export type Feedback = {
  ts: string;
  kind: FeedbackKind;
  what: string;
  friction: string;
  primitive?: Primitive;
  doc?: string;
  queries?: string[];
  resolvedBy?: string;
  cwd?: string;
  build?: string;
};

// The docs corpus an agent reads is a frozen build snapshot in packaged runs,
// so "the docs do not cover X" is ambiguous without knowing which snapshot the
// reporter read. Stamp both the index and every feedback entry with the build.
export function corpusBuildStamp(): string {
  return process.env.MODUS_DESKTOP_VERSION?.trim() || "dev";
}

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

export function formatFeedback(entry: Feedback, n: number): string {
  const tag = entry.primitive ? `${entry.kind}/${entry.primitive}` : entry.kind;
  const lines = [
    `#${n} [${tag}] ${entry.what}`,
    `    friction: ${entry.friction}`,
  ];
  if (entry.doc) lines.push(`    doc: \`${entry.doc}\``);
  if (entry.queries?.length) lines.push(`    tried: ${entry.queries.map((q) => `"${q}"`).join(", ")}`);
  if (entry.resolvedBy) lines.push(`    got past it by: ${entry.resolvedBy}`);
  if (entry.cwd) lines.push(`    from: ${entry.cwd}`);
  lines.push(`    filed: ${entry.ts}${entry.build ? ` (build ${entry.build})` : ""}`);
  return lines.join("\n");
}

function formatTitle(entry: Feedback, n: number): string {
  const tag = entry.primitive ? `${entry.kind}/${entry.primitive}` : entry.kind;
  return `${n}. [${tag}] ${entry.ts.slice(0, 10)} — ${entry.what}`;
}

function tally(entries: Feedback[], key: (e: Feedback) => string): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `${c} ${k}`)
    .join(", ");
}

// Validation for the `feedback` op, kept pure so the rejection rules are
// testable without touching the log. Returns the entry to append or the error
// to hand back.
export function buildFeedbackEntry(
  data: Record<string, unknown>,
  opts: { cwd?: string; docExists: (id: string) => boolean; now?: () => string },
): { entry: Feedback } | { error: string } {
  const kind = parseKind(data.kind);
  const what = typeof data.what === "string" ? data.what.trim() : "";
  const friction = typeof data.friction === "string" ? data.friction.trim() : "";

  if (!kind) {
    return { error: `kind is required — one of: ${FEEDBACK_KINDS.join(", ")}` };
  }
  if (!what) return { error: "what is required — what were you trying to do?" };
  if (!friction) return { error: "friction is required — what actually got in the way?" };

  // An unknown primitive must not silently file as unclassified — the filer
  // meant something, and a typo here makes the entry unfindable by filter.
  const primitive = data.primitive === undefined || data.primitive === ""
    ? undefined
    : parsePrimitive(data.primitive);
  if (data.primitive !== undefined && data.primitive !== "" && !primitive) {
    return { error: `unknown primitive: ${String(data.primitive)} — one of: ${PRIMITIVES.join(", ")}, or omit it` };
  }

  const doc = typeof data.doc === "string" && data.doc.trim() ? data.doc.trim() : undefined;
  if (doc && !opts.docExists(doc)) {
    return { error: `unknown doc id: ${doc} (use docs_list for valid ids, or omit doc)` };
  }

  const queries = Array.isArray(data.queries)
    ? data.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    : undefined;
  const resolvedBy = typeof data.resolvedBy === "string" && data.resolvedBy.trim()
    ? data.resolvedBy.trim()
    : undefined;

  return {
    entry: {
      ts: opts.now ? opts.now() : new Date().toISOString(),
      kind,
      what,
      friction,
      ...(primitive ? { primitive } : {}),
      ...(doc ? { doc } : {}),
      ...(queries?.length ? { queries } : {}),
      ...(resolvedBy ? { resolvedBy } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      build: corpusBuildStamp(),
    },
  };
}

const FEEDBACK_FORMATS = ["titles", "full"] as const;
type FeedbackFormat = (typeof FEEDBACK_FORMATS)[number];

// The MCP tool-result cap fits about 8 full entries; titles are one line each.
const FEEDBACK_DEFAULT_LIMIT: Record<FeedbackFormat, number> = { titles: 50, full: 8 };

// The whole feedback_list op minus the file read, pure so paging, filtering,
// and the invalid-filter rejections are testable against in-memory entries.
// Entry numbers are 1-based positions in the log file, so they stay stable as
// the append-only log grows.
export function runFeedbackList(
  entries: Feedback[],
  data: Record<string, unknown>,
): { ok: boolean; message?: string; error?: string } {
  if (data.entry !== undefined) {
    const n = typeof data.entry === "number" ? Math.floor(data.entry) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > entries.length) {
      return { ok: false, error: `entry must be a number from 1 to ${entries.length}` };
    }
    return { ok: true, message: formatFeedback(entries[n - 1]!, n) };
  }

  // A filter value outside the enum must reject, not silently return the whole
  // backlog — "nothing filed about this" and "the filter never applied" are
  // opposite conclusions and the caller cannot tell them apart.
  if (data.kind !== undefined && !parseKind(data.kind)) {
    return { ok: false, error: `unknown kind: ${String(data.kind)} — one of: ${FEEDBACK_KINDS.join(", ")}` };
  }
  if (data.primitive !== undefined && !parsePrimitive(data.primitive)) {
    return { ok: false, error: `unknown primitive: ${String(data.primitive)} — one of: ${PRIMITIVES.join(", ")}` };
  }
  const format: FeedbackFormat | undefined = data.format === undefined
    ? "titles"
    : FEEDBACK_FORMATS.includes(data.format as FeedbackFormat)
      ? (data.format as FeedbackFormat)
      : undefined;
  if (!format) {
    return { ok: false, error: `unknown format: ${String(data.format)} — one of: ${FEEDBACK_FORMATS.join(", ")}` };
  }

  const kindFilter = parseKind(data.kind);
  const primitiveFilter = parsePrimitive(data.primitive);

  let numbered = entries.map((entry, i) => ({ entry, n: i + 1 }));
  if (kindFilter) numbered = numbered.filter(({ entry }) => entry.kind === kindFilter);
  if (primitiveFilter) numbered = numbered.filter(({ entry }) => entry.primitive === primitiveFilter);

  if (!numbered.length) {
    const scope = kindFilter || primitiveFilter ? " matching that filter" : "";
    return { ok: true, message: `No feedback filed${scope}.` };
  }

  const limit = typeof data.limit === "number" && data.limit > 0
    ? Math.floor(data.limit)
    : FEEDBACK_DEFAULT_LIMIT[format];
  const offset = typeof data.offset === "number" && data.offset > 0 ? Math.floor(data.offset) : 0;

  const newestFirst = [...numbered].reverse();
  const page = newestFirst.slice(offset, offset + limit);
  const scoped = numbered.map(({ entry }) => entry);

  const header = [
    `${numbered.length} entr${numbered.length === 1 ? "y" : "ies"}`
      + (kindFilter || primitiveFilter ? " matching the filter" : " filed")
      + ` (${tally(scoped, (e) => e.kind)})`
      + (page.length < numbered.length
        ? `, showing ${page.length} newest${offset ? ` from offset ${offset}` : ""} as ${format === "titles" ? "titles" : "full entries"}`
        : ""),
    `by primitive: ${tally(scoped, (e) => e.primitive ?? "unset")}`,
    'Read one in full with { "op": "feedback_list", "entry": <n> }; page with offset/limit.',
    "",
  ];

  const body = page.map(({ entry, n }) =>
    format === "titles" ? formatTitle(entry, n) : formatFeedback(entry, n),
  );
  return { ok: true, message: [...header, ...body].join("\n") };
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
    "already been filed: a numbered titles overview with a tally by default —",
    "pass `entry: <n>` to read one entry in full, `offset`/`limit` to page, and",
    "`format: \"full\"` for full text (capped small; page through it).",
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
    return {
      ok: true,
      message: `Docs corpus build: ${corpusBuildStamp()}\n\n${formatIndex(ctx.cwd, audience)}`,
    };
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
      // Report the miss before the hits. A ranked list always looks plausible,
      // so without this an agent reads a doc that merely shares a common word,
      // finds nothing, and guesses at the contract instead of reading source.
      if (set.missingIdentifiers.length) {
        lines.push(
          `!! not in any doc: ${set.missingIdentifiers.map((i) => `\`${i}\``).join(", ")}`
          + " — read the source or check `generated/authoring-contracts`; do not infer it"
          + " from the hits below.",
        );
      }
      if (set.missingTerms.length) {
        lines.push(`!! no doc contains: ${set.missingTerms.map((t) => `"${t}"`).join(", ")}`);
      }
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
    const built = buildFeedbackEntry(data, {
      cwd: ctx.cwd,
      docExists: (id) => Boolean(getDoc(id, { cwd: ctx.cwd })),
    });
    if ("error" in built) return { ok: false, error: built.error };

    try {
      appendFeedback(built.entry);
    } catch (err: any) {
      return { ok: false, error: `could not record the feedback: ${err?.message ?? String(err)}` };
    }

    return {
      ok: true,
      message: [
        `Filed [${built.entry.kind}${built.entry.primitive ? `/${built.entry.primitive}` : ""}].`,
        "Carry on with the task. Say what you concluded and how you established it,",
        "so the reader knows which parts did not come from the documentation.",
      ].join("\n"),
    };
  },

  feedback_list: async (_ctx, data) => runFeedbackList(readFeedback(), data),
};
