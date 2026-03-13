import simpleGit from "simple-git";
import { readFile } from "fs/promises";
import { join } from "path";

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
  remote?: string;
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

    // Try to get remote URL for display name
    let remote: string | undefined;
    try {
      const url = (await git.remote(["get-url", "origin"])) as string | null;
      if (url) {
        // Extract "user/repo" from git URL
        const cleaned = url.trim().replace(/\.git$/, "");
        const match = cleaned.match(/[/:]([\w.-]+\/[\w.-]+)$/);
        remote = match?.[1] ?? cleaned.split("/").pop();
      }
    } catch { /* no remote */ }

    return {
      git: true,
      branch: status.current ?? "HEAD",
      remote,
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
  filesChanged?: number;
  additions?: number;
  deletions?: number;
};

export type GitLogEntryWithFiles = GitLogEntry & {
  files: string[];
};

function parseShortstat(line: string | undefined): Pick<GitLogEntry, "filesChanged" | "additions" | "deletions"> {
  if (!line) return {};
  const filesMatch = line.match(/(\d+) files? changed/);
  const additionsMatch = line.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = line.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? Number(filesMatch[1]) : undefined,
    additions: additionsMatch ? Number(additionsMatch[1]) : undefined,
    deletions: deletionsMatch ? Number(deletionsMatch[1]) : undefined,
  };
}

function parseGitLogRaw(raw: string): GitLogEntry[] {
  const SEP = "---GIT-LOG-SEP---";
  const END = "---GIT-LOG-END---";
  const entries: GitLogEntry[] = [];
  const chunks = raw.split(SEP).filter((s) => s.trim());

  for (const chunk of chunks) {
    const endIdx = chunk.indexOf(END);
    if (endIdx === -1) continue;

    const metaAndBody = chunk.slice(0, endIdx).trim();
    const afterEnd = chunk.slice(endIdx + END.length).trim();

    const firstNl = metaAndBody.indexOf("\n");
    const secondNl = metaAndBody.indexOf("\n", firstNl + 1);
    const thirdNl = metaAndBody.indexOf("\n", secondNl + 1);
    if (firstNl === -1 || secondNl === -1 || thirdNl === -1) continue;

    const hash = metaAndBody.slice(0, firstNl);
    const date = metaAndBody.slice(firstNl + 1, secondNl);
    const author = metaAndBody.slice(secondNl + 1, thirdNl);
    const message = metaAndBody.slice(thirdNl + 1).trim();

    let filesChanged: number | undefined;
    let additions: number | undefined;
    let deletions: number | undefined;

    if (afterEnd) {
      ({ filesChanged, additions, deletions } = parseShortstat(afterEnd));
    }

    entries.push({ hash, date, message, author, filesChanged, additions, deletions });
  }

  return entries;
}

function parseGitLogWithFilesRaw(raw: string): GitLogEntryWithFiles[] {
  const SEP = "---GIT-LOG-SEP---";
  const META_END = "---GIT-LOG-META-END---";
  const entries: GitLogEntryWithFiles[] = [];
  const chunks = raw.split(SEP).filter((s) => s.trim());

  for (const chunk of chunks) {
    const metaEndIdx = chunk.indexOf(META_END);
    if (metaEndIdx === -1) continue;

    const meta = chunk.slice(0, metaEndIdx).trim();
    const rest = chunk.slice(metaEndIdx + META_END.length).trim();

    const firstNl = meta.indexOf("\n");
    const secondNl = meta.indexOf("\n", firstNl + 1);
    const thirdNl = meta.indexOf("\n", secondNl + 1);
    if (firstNl === -1 || secondNl === -1 || thirdNl === -1) continue;

    const hash = meta.slice(0, firstNl);
    const date = meta.slice(firstNl + 1, secondNl);
    const author = meta.slice(secondNl + 1, thirdNl);
    const message = meta.slice(thirdNl + 1).trim();

    const lines = rest
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    let shortstat: string | undefined;
    if (lines.length > 0 && /(files? changed|insertions?\(\+\)|deletions?\(-\))/.test(lines[lines.length - 1]!)) {
      shortstat = lines.pop();
    }

    const files = lines;
    const { filesChanged, additions, deletions } = parseShortstat(shortstat);
    entries.push({
      hash,
      date,
      author,
      message,
      files,
      filesChanged,
      additions,
      deletions,
    });
  }

  return entries;
}

export async function gitLog(cwd: string, limit = 30): Promise<GitLogEntry[]> {
  try {
    const git = simpleGit(cwd);
    const raw = await git.raw([
      "log", `--max-count=${limit}`,
      "--format=---GIT-LOG-SEP---%n%H%n%aI%n%an%n%B---GIT-LOG-END---",
      "--shortstat",
    ]);

    return parseGitLogRaw(raw);
  } catch {
    return [];
  }
}

export async function gitLogWithFiles(
  cwd: string,
  opts: {
    limit?: number;
    since?: string;
    until?: string;
  } = {},
): Promise<GitLogEntryWithFiles[]> {
  const { limit = 30, since, until } = opts;

  try {
    const git = simpleGit(cwd);
    const args = [
      "log",
      `--max-count=${limit}`,
      "--format=---GIT-LOG-SEP---%n%H%n%aI%n%an%n%B---GIT-LOG-META-END---",
      "--name-only",
      "--shortstat",
    ];
    if (since) args.push(`--since=${since}`);
    if (until) args.push(`--until=${until}`);
    const raw = await git.raw(args);
    return parseGitLogWithFilesRaw(raw);
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

/** Get the working-tree diff for a single file (unstaged + staged) */
export async function gitFileDiff(cwd: string, filePath: string): Promise<FileDiff[]> {
  try {
    const git = simpleGit(cwd);
    // Try staged first, then unstaged — combine both
    const [staged, unstaged] = await Promise.all([
      git.diff(["--cached", "--", filePath]).catch(() => ""),
      git.diff(["--", filePath]).catch(() => ""),
    ]);
    const combined = [staged, unstaged].filter(Boolean).join("\n");
    if (!combined.trim()) return [];
    return parseDiff(combined);
  } catch {
    return [];
  }
}

export async function gitShow(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  try {
    const git = simpleGit(cwd);
    if (!/^[a-f0-9]+$/i.test(hash)) return null;

    // Get full commit metadata with %B for complete message body
    const END = "---GIT-SHOW-END---";
    const metaRaw = await git.raw([
      "log", "--max-count=1",
      `--format=%H%n%aI%n%an%n%B${END}`,
      hash,
    ]);
    const endIdx = metaRaw.indexOf(END);
    if (endIdx === -1) return null;

    const meta = metaRaw.slice(0, endIdx).trim();
    const firstNl = meta.indexOf("\n");
    const secondNl = meta.indexOf("\n", firstNl + 1);
    const thirdNl = meta.indexOf("\n", secondNl + 1);
    if (firstNl === -1 || secondNl === -1 || thirdNl === -1) return null;

    const commitHash = meta.slice(0, firstNl);
    const date = meta.slice(firstNl + 1, secondNl);
    const author = meta.slice(secondNl + 1, thirdNl);
    const message = meta.slice(thirdNl + 1).trim();

    // Check if this commit has a parent
    let hasParent = true;
    try {
      await git.revparse([`${hash}~1`]);
    } catch {
      hasParent = false;
    }

    let rawDiff: string;
    if (hasParent) {
      rawDiff = await git.diff([`${hash}~1`, hash]);
    } else {
      rawDiff = await git.raw(["diff-tree", "--patch", "--root", hash]);
    }

    return {
      hash: commitHash,
      date,
      message,
      author,
      files: parseDiff(rawDiff),
    };
  } catch {
    return null;
  }
}

/** Read the README file from a git repo working directory */
export async function gitReadme(cwd: string): Promise<{ name: string; content: string } | null> {
  const candidates = ["README.md", "readme.md", "Readme.md", "README", "README.txt", "README.rst"];
  for (const name of candidates) {
    try {
      const content = await readFile(join(cwd, name), "utf-8");
      return { name, content };
    } catch { /* try next */ }
  }
  return null;
}

/** Get file content at a specific commit */
export async function gitFileContent(cwd: string, hash: string, path: string): Promise<string | null> {
  try {
    const git = simpleGit(cwd);
    if (!/^[a-f0-9]+$/i.test(hash)) return null;
    return await git.raw(["show", `${hash}:${path}`]);
  } catch {
    return null;
  }
}
