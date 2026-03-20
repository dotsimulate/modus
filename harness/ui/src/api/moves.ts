import { API_BASE, authHeaders } from "./_fetch";

export type MoveInput = {
  name: string;
  label?: string;
  type: "text" | "textarea" | "select" | "toggle" | "number";
  options?: string[] | string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
};

export type MovePageInfo = {
  id: string;
  title: string;
  icon?: string;
  nav?: boolean;
};

export type MoveListItem = {
  name: string;
  label: string;
  description: string;
  origin?: "harness" | "project";
  icon?: string;
  mode?: "inline" | "branch" | "background";
  persistent?: boolean;
  inputs?: MoveInput[];
  tags?: string[];
  widget?: { mountOnAttach?: boolean };
  page?: MovePageInfo;
};

export type MoveWidgetInfo = {
  label: string;
  icon?: string;
  autoOpen?: boolean;
  mountOnAttach?: boolean;
  moduleUrl: string;
  moveName: string;
  /** Widget caching strategy: "instance" (default) keeps DOM alive, "module" caches JS only, "none" always reimports */
  cache?: "instance" | "module" | "none";
};

export type ActivateMoveResult = {
  token: string;
  mode: "inline" | "branch" | "background" | "persistent";
  persistent?: boolean;
  spawnedSessionId?: string;
  prompt?: string;
  moveRunId: number;
  apiToken?: string;
  instanceId?: string;
  widget?: MoveWidgetInfo;
};

export type AmbientMoveInfo = {
  moveName: string;
  activatedAt: number;
  inputs: Record<string, unknown>;
};

/** Call a move API op from the frontend (caller: "user") */
export async function callMoveOp(
  moveName: string,
  apiToken: string,
  op: string,
  data?: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/moves/${moveName}/op`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ apiToken, op, ...data }),
  });
  return res.json();
}

/** Restore all active widgets for a session (survives refresh) */
export async function fetchActiveWidget(sessionId: string): Promise<Array<{
  widget: MoveWidgetInfo;
  apiToken: string;
  instanceId: string;
}>> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/moves/widget`, {
    headers: authHeaders(),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMoves(projectCwd: string): Promise<MoveListItem[]> {
  const res = await fetch(
    `${API_BASE}/api/moves?cwd=${encodeURIComponent(projectCwd)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function activateMoveApi(
  sessionId: string,
  body: {
    moveName: string;
    inputs: Record<string, unknown>;
    cwd: string;
    userProfile?: string;
    modeOverride?: "inline" | "branch" | "background";
    forceNewSession?: boolean;
  },
): Promise<ActivateMoveResult> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/moves/activate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "move activation failed" }));
  if (!res.ok) {
    throw new Error(data.error ?? "move activation failed");
  }
  return data;
}

/** Notify backend that a session ID changed so move registry entries get updated */
export async function rekeyMoveSession(oldSessionId: string, newSessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${oldSessionId}/moves/rekey`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ newSessionId }),
  });
}

/** Rekey a specific move registration by its apiToken — works even when old sessionId is empty */
export async function rekeyMoveByTokenApi(apiToken: string, newSessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/moves/rekey-by-token`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ apiToken, newSessionId }),
  });
}

export async function activateProjectMoveApi(body: {
  moveName: string;
  inputs: Record<string, unknown>;
  cwd: string;
  userProfile?: string;
  modeOverride?: "inline" | "branch" | "background";
  forceNewSession?: boolean;
}): Promise<ActivateMoveResult> {
  const res = await fetch(`${API_BASE}/api/moves/activate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "move activation failed" }));
  if (!res.ok) {
    throw new Error(data.error ?? "move activation failed");
  }
  return data;
}

// ── Widget-first activation (attach/activate) ──

export type AttachMoveResult = {
  apiToken: string;
  instanceId: string;
  widget: MoveWidgetInfo;
};

/** Phase 1: attach a move — creates API registration + widget, no gather/message */
export async function attachMoveApi(body: {
  moveName: string;
  inputs: Record<string, unknown>;
  cwd: string;
  sessionId?: string;
  userProfile?: string;
}): Promise<AttachMoveResult> {
  const res = await fetch(`${API_BASE}/api/moves/${body.moveName}/attach`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "attach failed" }));
  if (!res.ok) throw new Error(data.error ?? "attach failed");
  return data;
}

/** Phase 2: activate an attached move — run gather + send message from widget */
export async function activateAttachedMoveApi(
  moveName: string,
  apiToken: string,
  text?: string,
  userProfile?: string,
): Promise<{ ok: boolean; prompt?: string; moveRunId?: number; error?: string }> {
  const res = await fetch(`${API_BASE}/api/moves/${moveName}/activate-attached`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ apiToken, text, userProfile }),
  });
  return res.json();
}

/** Clean up an attached move without activating */
export async function detachMoveApi(moveName: string, apiToken: string): Promise<void> {
  await fetch(`${API_BASE}/api/moves/${moveName}/detach`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ apiToken }),
  });
}

// ── Ambient (persistent) moves ──

export async function fetchAmbientMoves(sessionId: string): Promise<AmbientMoveInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/moves/ambient`, {
    headers: authHeaders(),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function deactivateAmbientMoveApi(
  sessionId: string,
  moveName: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/moves/deactivate`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ moveName }),
  });
  return res.json();
}
