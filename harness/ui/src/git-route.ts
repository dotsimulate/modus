import { useEffect, useState } from "react";
import { VIEW_SLUGS } from "./views";

export type GitRouteState = {
  commit?: string;
  file?: string;
  wt?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanValue(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getHashPath(hash: string): string {
  const raw = hash.replace(/^#\/?/, "");
  const queryIndex = raw.indexOf("?");
  return queryIndex === -1 ? raw : raw.slice(0, queryIndex);
}

function getHashParams(hash: string): URLSearchParams {
  const raw = hash.replace(/^#\/?/, "");
  const queryIndex = raw.indexOf("?");
  return new URLSearchParams(queryIndex === -1 ? "" : raw.slice(queryIndex + 1));
}

function buildHash(path: string, state: GitRouteState): string {
  const params = new URLSearchParams();
  const commit = cleanValue(state.commit);
  const file = cleanValue(state.file);
  const wt = cleanValue(state.wt);

  if (commit) params.set("commit", commit);
  if (file) params.set("file", file);
  if (wt) params.set("wt", wt);

  const query = params.toString();
  return query ? `#${path}?${query}` : `#${path}`;
}

export function parseGitRouteState(hash = window.location.hash): GitRouteState {
  const params = getHashParams(hash);
  return {
    commit: cleanValue(params.get("commit")),
    file: cleanValue(params.get("file")),
    wt: cleanValue(params.get("wt")),
  };
}

function resolveGitPathFromCurrentHash(hash = window.location.hash): string {
  const path = getHashPath(hash);
  if (!path) return "git";

  const slash = path.indexOf("/");
  if (slash !== -1) {
    return `${path.slice(0, slash)}/git`;
  }

  if (VIEW_SLUGS.has(path) || path.startsWith("page:") || UUID_RE.test(path)) {
    return "git";
  }

  return `${path}/git`;
}

export function navigateToGitRoute(state: GitRouteState = {}): void {
  const next = buildHash(resolveGitPathFromCurrentHash(), state);
  window.location.hash = next.slice(1);
}

export function replaceGitRouteState(state: GitRouteState): void {
  const next = buildHash(getHashPath(window.location.hash), state);
  window.history.replaceState(null, "", next);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useGitRouteState(): GitRouteState {
  const [state, setState] = useState<GitRouteState>(() => parseGitRouteState());

  useEffect(() => {
    const sync = () => setState(parseGitRouteState());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return state;
}
