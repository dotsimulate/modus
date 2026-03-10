import { API_BASE, authHeaders } from "./_fetch";

export type PromptInput = {
  name: string;
  type?: "text" | "toggle" | "select";
  placeholder?: string;
  required?: boolean;
  default?: string;
  options?: string[];
};

export type PromptListItem = {
  name: string;
  label: string;
  description?: string;
  icon?: string;
  profile?: string;
  inputs?: PromptInput[];
  settings?: {
    provider?: string;
    model?: string;
    effort?: string;
    cwd?: string;
  };
  tags?: string[];
  source: string;
};

export type RenderResult = {
  rendered: string;
  config: {
    label: string;
    profile?: string;
    settings?: PromptListItem["settings"];
  };
};

export async function fetchPrompts(opts?: { tags?: string[]; projectCwd?: string }): Promise<PromptListItem[]> {
  const params = new URLSearchParams();
  if (opts?.tags?.length) params.set("tags", opts.tags.join(","));
  if (opts?.projectCwd) params.set("projectCwd", opts.projectCwd);
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/api/prompts${qs ? `?${qs}` : ""}`, { headers: authHeaders() });
  return res.json();
}

export async function renderPromptApi(
  name: string,
  vars: Record<string, unknown>,
): Promise<RenderResult> {
  const res = await fetch(`${API_BASE}/api/prompts/${encodeURIComponent(name)}/render`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(vars),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "render failed" }));
    throw new Error(err.error ?? "render failed");
  }
  return res.json();
}

export async function reloadPromptsApi(): Promise<{ ok: boolean; count: number }> {
  const res = await fetch(`${API_BASE}/api/prompts/reload`, {
    method: "POST",
    headers: authHeaders(),
  });
  return res.json();
}
