/**
 * Dynamic favicon — mirrors the PortalEye visual in the browser tab.
 *
 * Idle:   white circle (ring only)
 * Active: white circle + N dots inside, positioned like the PortalEye
 *
 * Subscribes to the session store and swaps the favicon data URI
 * when the active agent count changes. No animation loop — just
 * state-driven swaps.
 */

import { subscribeStore, getStoreSessionIds, getSessionState } from "./sessionStore";

let currentCount = -1;
let linkEl: HTMLLinkElement | null = null;

/** Build an SVG string for the favicon with N agent dots */
function buildSvg(dots: number): string {
  const capped = Math.min(dots, 3);

  // Dot positions inside the ring — hand-placed for clarity at 16-32px
  // These are offset from center (16,16), placed to read well at small sizes
  const dotPositions: [number, number][] = [
    [16, 16],       // center
    [12, 13],       // upper-left of center
    [20, 19],       // lower-right of center
  ];

  let dotsSvg = "";
  for (let i = 0; i < capped; i++) {
    const [cx, cy] = dotPositions[i];
    dotsSvg += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="white"/>`;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none">`,
    `<circle cx="16" cy="16" r="13" stroke="white" stroke-width="1.5"/>`,
    dotsSvg,
    `</svg>`,
  ].join("");
}

function toDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Count sessions with status "running" or "starting" */
function countActive(sessionIds: string[]): number {
  let count = 0;
  for (const id of sessionIds) {
    const state = getSessionState(id);
    if (state && (state.status === "running" || state.status === "starting" || state.status === "interrupting")) {
      count++;
    }
  }
  return count;
}

function update() {
  const ids = getStoreSessionIds();
  const active = countActive(ids);

  if (active === currentCount) return;
  currentCount = active;

  if (!linkEl) {
    linkEl = document.querySelector('link[rel="icon"]');
  }
  if (!linkEl) return;

  if (active === 0) {
    // Reset to static file (avoids stale data URIs)
    linkEl.href = "/favicon.svg";
  } else {
    linkEl.href = toDataUri(buildSvg(active));
  }
}

/** Initialize favicon tracking. Call once at app startup. */
export function initFavicon() {
  // Ensure the link element exists
  linkEl = document.querySelector('link[rel="icon"]');
  if (!linkEl) {
    linkEl = document.createElement("link");
    linkEl.rel = "icon";
    linkEl.type = "image/svg+xml";
    linkEl.href = "/favicon.svg";
    document.head.appendChild(linkEl);
  }

  // Subscribe to store changes
  subscribeStore(update);
}
