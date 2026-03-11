import { API_BASE, authHeaders } from "./_fetch";
import type { Profile, GlobalConfig, ProviderCapabilities, UserProfile, UserProfileState } from "./types";

export async function fetchProfiles(cwd?: string): Promise<Profile[]> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await fetch(`${API_BASE}/api/profiles${params}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchProfile(name: string): Promise<Profile> {
  const res = await fetch(`${API_BASE}/api/profiles/${name}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Profile not found: ${name}`);
  return res.json();
}

export async function saveProfileApi(name: string, profile: Omit<Profile, "name">, cwd?: string): Promise<void> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await fetch(`${API_BASE}/api/profiles/${name}${params}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(profile),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Failed to save profile: ${name}`);
  }
}

export async function deleteProfileApi(name: string, cwd?: string): Promise<void> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  await fetch(`${API_BASE}/api/profiles/${name}${params}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function fetchGlobalConfig(cwd?: string): Promise<GlobalConfig> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await fetch(`${API_BASE}/api/profiles/_global${params}`, { headers: authHeaders() });
  return res.json();
}

export async function saveGlobalConfigApi(config: GlobalConfig, cwd?: string): Promise<void> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await fetch(`${API_BASE}/api/profiles/_global${params}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || "Failed to save global config");
  }
}

export async function checkSecrets(vars: string[]): Promise<{ status: Record<string, boolean>; secretsFile: string }> {
  const res = await fetch(`${API_BASE}/api/secrets/check`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ vars }),
  });
  return res.json();
}

// ── Providers ──

export async function fetchProviders(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/providers`, { headers: authHeaders() });
  return res.json();
}

export async function fetchProviderCapabilities(): Promise<ProviderCapabilities[]> {
  const res = await fetch(`${API_BASE}/api/provider-capabilities`, { headers: authHeaders() });
  return res.json();
}

export type ProviderModel = { id: string; owned_by?: string };

export async function fetchProviderModels(provider: string): Promise<ProviderModel[]> {
  const res = await fetch(`${API_BASE}/api/providers/${encodeURIComponent(provider)}/models`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

// ── User Profiles ──

export async function fetchUserProfiles(): Promise<UserProfile[]> {
  const res = await fetch(`${API_BASE}/api/user-profiles`, { headers: authHeaders() });
  return res.json();
}

export async function fetchUserProfile(name: string): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/api/user-profiles/${encodeURIComponent(name)}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`User profile not found: ${name}`);
  return res.json();
}

export async function saveUserProfileApi(name: string, profile: Omit<UserProfile, "name">): Promise<void> {
  const res = await fetch(`${API_BASE}/api/user-profiles/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(profile),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Failed to save user profile: ${name}`);
  }
}

export async function patchUserProfileApi(name: string, patch: Partial<UserProfile>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/user-profiles/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Failed to update user profile: ${name}`);
  }
}

// ── User Profile State (runtime, separate from config) ──

export async function fetchUserProfileState(name: string): Promise<UserProfileState> {
  const res = await fetch(`${API_BASE}/api/user-profiles/${encodeURIComponent(name)}/state`, { headers: authHeaders() });
  return res.json();
}

export async function patchUserProfileStateApi(name: string, patch: Partial<UserProfileState>): Promise<void> {
  await fetch(`${API_BASE}/api/user-profiles/${encodeURIComponent(name)}/state`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
}
