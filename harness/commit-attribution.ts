import { relative, resolve } from "path";
import { getSession } from "./db";
import { gitLogWithFiles, type GitLogEntry, type GitLogEntryWithFiles } from "./git";
import { getActiveSession } from "./session-manager";
import traceDb from "./trace-db";
import { queryTouches } from "./trace";

const COMMIT_ATTRIBUTION_WINDOW_MS = 2 * 60 * 60 * 1000;
const COMMIT_ATTRIBUTION_LIMIT = 40;

export type CommitAttributionReason =
  | "no-session-cwd"
  | "no-file-touches"
  | "no-nearby-commit"
  | "no-file-overlap";

export type CommitAttribution = {
  matched: boolean;
  commit?: GitLogEntry;
  matchedFiles?: string[];
  source?: "session";
  reason?: CommitAttributionReason;
};

function normalizeRepoRelativePath(filePath: string, cwd: string): string | null {
  if (!filePath || typeof filePath !== "string") return null;
  const repoRoot = resolve(cwd);
  const absolutePath = resolve(repoRoot, filePath);
  const relativePath = relative(repoRoot, absolutePath);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..")) return null;
  return relativePath.replace(/\\/g, "/");
}

function collectTouchedFiles(cwd: string, touchedFiles: string[]): string[] {
  const normalized = new Set<string>();
  for (const filePath of touchedFiles) {
    const next = normalizeRepoRelativePath(filePath, cwd);
    if (next) normalized.add(next);
  }
  return [...normalized];
}

export function determineCommitAttribution(input: {
  cwd: string;
  touchedFiles: string[];
  commits: GitLogEntryWithFiles[];
}): CommitAttribution {
  const touchedFiles = collectTouchedFiles(input.cwd, input.touchedFiles);
  if (touchedFiles.length === 0) {
    return { matched: false, reason: "no-file-touches" };
  }

  if (input.commits.length === 0) {
    return { matched: false, reason: "no-nearby-commit" };
  }

  const touchedFileSet = new Set(touchedFiles);
  const matches = input.commits
    .map((commit) => {
      const matchedFiles = commit.files
        .map((filePath) => normalizeRepoRelativePath(filePath, input.cwd))
        .filter((filePath): filePath is string => !!filePath && touchedFileSet.has(filePath));
      return { commit, matchedFiles };
    })
    .filter((entry) => entry.matchedFiles.length > 0)
    .sort((a, b) => {
      if (b.matchedFiles.length !== a.matchedFiles.length) {
        return b.matchedFiles.length - a.matchedFiles.length;
      }
      return Date.parse(b.commit.date) - Date.parse(a.commit.date);
    });

  const best = matches[0];
  if (!best) {
    return { matched: false, reason: "no-file-overlap" };
  }

  return {
    matched: true,
    commit: {
      hash: best.commit.hash,
      date: best.commit.date,
      message: best.commit.message,
      author: best.commit.author,
      filesChanged: best.commit.filesChanged,
      additions: best.commit.additions,
      deletions: best.commit.deletions,
    },
    matchedFiles: best.matchedFiles,
    source: "session",
  };
}

export async function getSessionCommitAttribution(sessionId: string): Promise<CommitAttribution> {
  const active = getActiveSession(sessionId);
  const session = getSession(sessionId);
  const cwd = active?.cwd ?? session?.cwd ?? null;
  if (!cwd) {
    return { matched: false, reason: "no-session-cwd" };
  }

  const startedAt = active?.startedAt ?? session?.created_at;
  const lastEventAt = active?.lastEventAt ?? session?.last_message_at ?? session?.updated_at;
  if (!startedAt || !lastEventAt) {
    return { matched: false, reason: "no-nearby-commit" };
  }

  const touches = queryTouches(traceDb, {
    sessionId,
    from: startedAt,
    to: lastEventAt,
    ops: ["write", "edit"],
    limit: 5000,
  });

  const commits = await gitLogWithFiles(cwd, {
    limit: COMMIT_ATTRIBUTION_LIMIT,
    since: new Date(startedAt).toISOString(),
    until: new Date(lastEventAt + COMMIT_ATTRIBUTION_WINDOW_MS).toISOString(),
  });

  return determineCommitAttribution({
    cwd,
    touchedFiles: touches.map((touch) => touch.filePath),
    commits,
  });
}
