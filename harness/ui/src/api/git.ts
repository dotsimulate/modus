import { API_BASE, authHeaders } from "./_fetch";
import type { GitStatus, GitCommit, GitCommitDetail } from "./types";

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
