import simpleGit from "simple-git";

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const git = simpleGit(cwd);
    await git.revparse(["--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

export type GitStatusResult = {
  git: true;
  branch: string;
  ahead: number;
  behind: number;
  files: {
    modified: string[];
    staged: string[];
    untracked: string[];
  };
};

export async function gitStatus(cwd: string): Promise<GitStatusResult | { git: false }> {
  try {
    const git = simpleGit(cwd);
    const status = await git.status();
    return {
      git: true,
      branch: status.current ?? "HEAD",
      ahead: status.ahead,
      behind: status.behind,
      files: {
        modified: status.modified,
        staged: status.staged,
        untracked: status.not_added,
      },
    };
  } catch {
    return { git: false };
  }
}

export type GitLogEntry = {
  hash: string;
  date: string;
  message: string;
  author: string;
};

export async function gitLog(cwd: string, limit = 30): Promise<GitLogEntry[]> {
  try {
    const git = simpleGit(cwd);
    const log = await git.log({ maxCount: limit });
    return log.all.map((c) => ({
      hash: c.hash,
      date: c.date,
      message: c.message,
      author: c.author_name,
    }));
  } catch {
    return [];
  }
}

// ── Structured diff types ──

export type DiffLine = {
  type: "add" | "del" | "ctx";
  content: string;
  oldNum: number | null;
  newNum: number | null;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type FileDiff = {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

export type GitCommitDetail = {
  hash: string;
  date: string;
  message: string;
  author: string;
  files: FileDiff[];
};

/** Parse a unified diff string into structured per-file sections */
function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  // Split on file boundaries
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");

    // Extract file path from first line: "a/path b/path"
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    const path = headerMatch?.[2] ?? headerMatch?.[1] ?? "unknown";

    let additions = 0;
    let deletions = 0;
    const hunks: DiffHunk[] = [];

    let currentHunk: DiffHunk | null = null;
    let oldNum = 0;
    let newNum = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;

      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        const hunk: DiffHunk = {
          header: line,
          oldStart: Number(hunkMatch[1]),
          newStart: Number(hunkMatch[2]),
          lines: [],
        };
        currentHunk = hunk;
        oldNum = hunk.oldStart;
        newNum = hunk.newStart;
        hunks.push(hunk);
        continue;
      }

      if (!currentHunk) continue;

      // Skip diff metadata lines
      if (line.startsWith("---") || line.startsWith("+++") ||
          line.startsWith("index ") || line.startsWith("new file") ||
          line.startsWith("old mode") || line.startsWith("new mode") ||
          line.startsWith("deleted file") || line.startsWith("similarity") ||
          line.startsWith("rename ") || line.startsWith("Binary ")) continue;

      if (line.startsWith("+")) {
        additions++;
        currentHunk.lines.push({ type: "add", content: line.slice(1), oldNum: null, newNum: newNum++ });
      } else if (line.startsWith("-")) {
        deletions++;
        currentHunk.lines.push({ type: "del", content: line.slice(1), oldNum: oldNum++, newNum: null });
      } else if (line.startsWith(" ") || line === "") {
        currentHunk.lines.push({ type: "ctx", content: line.slice(1), oldNum: oldNum++, newNum: newNum++ });
      }
    }

    files.push({ path, additions, deletions, hunks });
  }

  return files;
}

export async function gitShow(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  try {
    const git = simpleGit(cwd);
    if (!/^[a-f0-9]+$/i.test(hash)) return null;

    // Check if this commit has a parent
    let hasParent = true;
    try {
      await git.revparse([`${hash}~1`]);
    } catch {
      hasParent = false;
    }

    const log = await git.log({ maxCount: 1, from: hasParent ? `${hash}~1` : hash, to: hash });
    const entry = log.latest;
    if (!entry) return null;

    let rawDiff: string;
    if (hasParent) {
      rawDiff = await git.diff([`${hash}~1`, hash]);
    } else {
      rawDiff = await git.raw(["diff-tree", "--patch", "--root", hash]);
    }

    return {
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name,
      files: parseDiff(rawDiff),
    };
  } catch {
    return null;
  }
}
