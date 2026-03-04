export const API_BASE = import.meta.env.VITE_API_URL ?? "";

// Auth token — PIN session token from login (stored in localStorage).
// HARNESS_TOKEN is for agents only; browsers authenticate via PIN.
export function getAuthToken(): string {
  return localStorage.getItem("harness_token") || "";
}

export function setAuthToken(token: string) {
  localStorage.setItem("harness_token", token);
}

export function clearAuthToken() {
  localStorage.removeItem("harness_token");
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const token = getAuthToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export function tokenParam(): string {
  const token = getAuthToken();
  return token ? `token=${token}` : "";
}
