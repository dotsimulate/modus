import type { ComponentType } from "react";
import * as ReactModule from "react";
import * as ReactJSXRuntime from "react/jsx-runtime";
import * as ReactJSXDevRuntime from "react/jsx-dev-runtime";
import { authHeaders } from "../modusClient";
import { bindHostImports, redirectHostModules } from "../move-host-imports";

const moduleCache = new Map<string, ComponentType<unknown>>();
const cssInjected = new Set<string>();

export function getCachedMoveComponent<Props>(url: string): ComponentType<Props> | null {
  return (moduleCache.get(url) as ComponentType<Props> | undefined) ?? null;
}

export function evictMoveComponent(url: string): boolean {
  return moduleCache.delete(url);
}

/** Inject a move's shared widget.css once. Missing CSS is a supported case. */
export async function loadMoveComponentCSS(cssUrl: string, moveName: string): Promise<void> {
  if (cssInjected.has(moveName)) return;
  try {
    const res = await fetch(cssUrl, { headers: authHeaders() });
    if (!res.ok) return;
    const css = await res.text();
    if (!css.trim()) return;
    const style = document.createElement("style");
    style.setAttribute("data-move-widget", moveName);
    style.textContent = css;
    document.head.appendChild(style);
    cssInjected.add(moveName);
  } catch {
    // CSS loading is best-effort.
  }
}

/**
 * Fetch authored React, bind its external React imports to the host instance,
 * and import it through a blob URL. Both panel widgets and transcript tool
 * views use this exact path so their runtime behavior cannot drift.
 */
export async function loadMoveComponent<Props>(
  url: string,
  namedExport: string,
): Promise<ComponentType<Props>> {
  const cached = getCachedMoveComponent<Props>(url);
  if (cached) return cached;

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Move component fetch failed: ${res.status}`);
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
    if (!component) throw new Error("Move component module has no default export");
    moduleCache.set(url, component as ComponentType<unknown>);
    return component as ComponentType<Props>;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
