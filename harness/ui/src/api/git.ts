import { API_BASE, authHeaders } from "./_fetch";
import type { GitStatus, GitCommit, GitCommitDetail, FileDiff } from "./types";

export async function fetchGitStatus(cwd: string): Promise<GitStatus> {
  const res = await fetch(
    `${API_BASE}/api/git/status?cwd=${encodeURIComponent(cwd)}`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function fetchGitLog(cwd: string, limit = 30): Promise<GitCommit[]> {
  const res = await fetch(
    `${API_BASE}/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=${limit}`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function fetchGitShow(cwd: string, hash: string): Promise<GitCommitDetail> {
  const res = await fetch(
    `${API_BASE}/api/git/show/${hash}?cwd=${encodeURIComponent(cwd)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error("Failed to load commit");
  return res.json();
}

export async function fetchGitFileDiff(cwd: string, file: string): Promise<FileDiff[]> {
  const res = await fetch(
    `${API_BASE}/api/git/file-diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function fetchGitFileContent(cwd: string, hash: string, path: string): Promise<string | null> {
  const res = await fetch(
    `${API_BASE}/api/git/file-content?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(path)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.content ?? null;
}

export async function fetchGitReadme(cwd: string): Promise<{ name: string; content: string } | null> {
  const res = await fetch(
    `${API_BASE}/api/git/readme?cwd=${encodeURIComponent(cwd)}`,
    { headers: authHeaders() },
  );
  return res.json();
}

export async function openInEditor(filePath: string, line?: number): Promise<void> {
  await fetch(`${API_BASE}/api/open-in-editor`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ filePath, line }),
  });
}
