import type { ComponentType } from "react";
import { authHeaders } from "../modusClient";
import {
  evictAuthoredComponent,
  getCachedAuthoredComponent,
  loadAuthoredComponent,
} from "./authored-component-loader";
const cssInjected = new Set<string>();

export function getCachedMoveComponent<Props>(url: string): ComponentType<Props> | null {
  return getCachedAuthoredComponent<Props>(url);
}

export function evictMoveComponent(url: string): boolean {
  return evictAuthoredComponent(url);
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
  return loadAuthoredComponent<Props>(url, namedExport, "Move");
}
