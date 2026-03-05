import { API_BASE, authHeaders } from "./_fetch";
import type { Profile, GlobalConfig, UserProfile, UserProfileState } from "./types";

export async function fetchProfiles(): Promise<Profile[]> {
  const res = await fetch(`${API_BASE}/api/profiles`, { headers: authHeaders() });
  return res.json();
}

export async function fetchProfile(name: string): Promise<Profile> {
  const res = await fetch(`${API_BASE}/api/profiles/${name}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Profile not found: ${name}`);
  return res.json();
}

export async function saveProfileApi(name: string, profile: Omit<Profile, "name">): Promise<void> {
  await fetch(`${API_BASE}/api/profiles/${name}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(profile),
  });
}

export async function deleteProfileApi(name: string): Promise<void> {
  await fetch(`${API_BASE}/api/profiles/${name}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function fetchGlobalConfig(): Promise<GlobalConfig> {
  const res = await fetch(`${API_BASE}/api/profiles/_global`, { headers: authHeaders() });
  return res.json();
}

export async function saveGlobalConfigApi(config: GlobalConfig): Promise<void> {
  await fetch(`${API_BASE}/api/profiles/_global`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(config),
  });
}

export async function checkSecrets(vars: string[]): Promise<{ status: Record<string, boolean>; secretsFile: string }> {
  const res = await fetch(`${API_BASE}/api/secrets/check`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ vars }),
  });
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
  await fetch(`${API_BASE}/api/user-profiles/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(profile),
  });
}

export async function patchUserProfileApi(name: string, patch: Partial<UserProfile>): Promise<void> {
  await fetch(`${API_BASE}/api/user-profiles/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
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
