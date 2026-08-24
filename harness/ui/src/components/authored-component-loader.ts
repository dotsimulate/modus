import type { ComponentType } from "react";
import * as ReactModule from "react";
import * as ReactJSXRuntime from "react/jsx-runtime";
import * as ReactJSXDevRuntime from "react/jsx-dev-runtime";
import { authHeaders } from "../modusClient";
import { bindHostImports, redirectHostModules } from "../move-host-imports";

const moduleCache = new Map<string, ComponentType<unknown>>();

export function getCachedAuthoredComponent<Props>(url: string): ComponentType<Props> | null {
  return (moduleCache.get(url) as ComponentType<Props> | undefined) ?? null;
}

export function evictAuthoredComponent(url: string): boolean {
  return moduleCache.delete(url);
}

/** Shared trusted-local React loader used by moves and conversation projections. */
export async function loadAuthoredComponent<Props>(
  url: string,
  namedExport: string,
  surface = "Authored",
): Promise<ComponentType<Props>> {
  const cached = getCachedAuthoredComponent<Props>(url);
  if (cached) return cached;

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: string; detail?: string } | null;
    throw new Error(`${surface} component fetch failed: ${res.status}${detail?.error ? ` · ${detail.error}` : ""}${detail?.detail ? ` · ${detail.detail}` : ""}`);
  }
  let js = await res.text();

  (window as any).__MODUS_REACT__ = ReactModule;
  (window as any).__MODUS_JSX_RUNTIME__ = ReactJSXRuntime;
  (window as any).__MODUS_JSX_DEV_RUNTIME__ = ReactJSXDevRuntime;

  js = redirectHostModules(js);
  const shim = `
const __MODUS_REACT__ = window.__MODUS_REACT__;
const __MODUS_JSX_RUNTIME__ = window.__MODUS_JSX_RUNTIME__;
const __MODUS_JSX_DEV_RUNTIME__ = window.__MODUS_JSX_DEV_RUNTIME__;
${bindHostImports(js)}
`;

  const blobUrl = URL.createObjectURL(new Blob([shim], { type: "application/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ blobUrl);
    const component = mod.default ?? mod.Widget ?? mod[namedExport];
    if (!component) throw new Error(`${surface} component module has no default export`);
    moduleCache.set(url, component as ComponentType<unknown>);
    return component as ComponentType<Props>;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
