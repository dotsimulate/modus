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

import type { MoveApiHandler, MoveContext } from "../../move-types";
import { getDoc, listDocs, searchDocs, type DocAudience } from "../../docs-registry";

const INDEX_SUMMARY_MAX = 110;

// The docs corpus an agent reads is a frozen build snapshot in packaged runs,
// so "the docs do not cover X" is ambiguous without knowing which snapshot the
// reader saw. Stamp the index with the build.
export function corpusBuildStamp(): string {
  return process.env.MODUS_DESKTOP_VERSION?.trim() || "dev";
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
};
