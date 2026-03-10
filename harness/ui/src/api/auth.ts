import { API_BASE, authHeaders } from "./_fetch";

/** Check if PIN auth is required */
export async function authStatus(): Promise<{ required: boolean; setup: boolean; name: string | null }> {
  const res = await fetch(`${API_BASE}/api/auth/status`);
  return res.json();
}

/** First-run setup — set a new PIN (only works if none exists) */
export async function setupNewPin(pin: string, name?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, name }),
  });
  if (!res.ok) throw new Error("Setup failed");
  const data = await res.json();
  return data.token;
}

/** Verify PIN, returns session token on success */
export async function verifyPin(pin: string, name?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, name }),
  });
  if (!res.ok) throw new Error("Wrong PIN");
  const data = await res.json();
  return data.token;
}

/** Get current user info */
export async function fetchMe(): Promise<{ name: string | null }> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
  return res.json();
}

/** Lock — invalidate all browser sessions server-side */
export async function lockAll(): Promise<void> {
  await fetch(`${API_BASE}/api/auth/lock`, { method: "POST", headers: authHeaders() });
}

/** Check if current token is still valid — throws on 401 */
export async function checkToken(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions?limit=1`, { headers: authHeaders() });
  if (!res.ok) throw new Error("unauthorized");
}

/** Change PIN — verifies old PIN before updating */
export async function changePinApi(oldPin: string, newPin: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/change-pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ oldPin, newPin }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "Failed to change PIN");
  }
}

export async function healthCheck(): Promise<{ status: string; uptime: number }> {
  const res = await fetch(`${API_BASE}/health`);
  return res.json();
}
