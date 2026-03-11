import { API_BASE, authHeaders } from "./_fetch";
import type { ActiveProjectUiAsset, ProjectUiAssetInfo, ProjectUiState } from "./types";

export async function fetchProjectUiState(cwd: string): Promise<ProjectUiState> {
  const res = await fetch(`${API_BASE}/api/ui/state?cwd=${encodeURIComponent(cwd)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || "Failed to fetch project UI state");
  }
  return res.json();
}

export async function fetchProjectThemes(cwd: string): Promise<ProjectUiAssetInfo[]> {
  const res = await fetch(`${API_BASE}/api/ui/themes?cwd=${encodeURIComponent(cwd)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || "Failed to fetch project themes");
  }
  return res.json();
}

export async function fetchProjectFonts(cwd: string): Promise<ProjectUiAssetInfo[]> {
  const res = await fetch(`${API_BASE}/api/ui/fonts?cwd=${encodeURIComponent(cwd)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || "Failed to fetch project fonts");
  }
  return res.json();
}

export async function activateProjectThemeApi(cwd: string, themeId: string): Promise<ActiveProjectUiAsset> {
  const res = await fetch(`${API_BASE}/api/ui/themes/activate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ cwd, themeId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Failed to activate theme: ${themeId}`);
  }
  return res.json();
}

export async function activateProjectFontApi(cwd: string, fontId: string): Promise<ActiveProjectUiAsset> {
  const res = await fetch(`${API_BASE}/api/ui/fonts/activate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ cwd, fontId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Failed to activate font: ${fontId}`);
  }
  return res.json();
}
