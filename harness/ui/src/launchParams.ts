/**
 * Launch parameters — extracted from URL query params on first load.
 *
 * Lives in its own module to avoid a circular dependency between
 * App.tsx and components that need the launch CWD (Dashboard, ProjectSetup).
 */

const params = new URLSearchParams(window.location.search);
const urlCwd = params.get("cwd");
if (urlCwd) {
  sessionStorage.setItem("modus:launch-cwd", urlCwd);
  const url = new URL(window.location.href);
  url.searchParams.delete("cwd");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

export const LAUNCH_CWD = urlCwd ?? sessionStorage.getItem("modus:launch-cwd") ?? "";
