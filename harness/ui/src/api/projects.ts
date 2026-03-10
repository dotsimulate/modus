import { API_BASE, authHeaders } from "./_fetch";

export type InitStatus = {
  initialized: boolean;
  projectId: string | null;
  registered: boolean;
  meta: { id: string; name?: string; created?: string } | null;
  pathMatch: boolean;
};

export type InitResult = {
  ok: true;
  projectId: string;
  created: string[];
  skipped: string[];
  alreadyInitialized: boolean;
};

export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  created: string;
  pathExists: boolean;
};

export async function fetchInitStatus(cwd: string): Promise<InitStatus> {
  const res = await fetch(`${API_BASE}/api/init/status?cwd=${encodeURIComponent(cwd)}`, {
    headers: authHeaders(),
  });
  return res.json();
}

export async function initProject(cwd: string, name?: string): Promise<InitResult> {
  const res = await fetch(`${API_BASE}/api/init`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ cwd, name }),
  });
  return res.json();
}

export async function fetchProjects(): Promise<ProjectInfo[]> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    headers: authHeaders(),
  });
  return res.json();
}
