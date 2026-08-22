export type DesktopBuildProfile = "debug" | "release";

/** Resolve the one Tauri target profile this staging invocation may replace. */
export function desktopBuildProfile(
  devMode: boolean,
  tauriEnvDebug = process.env.TAURI_ENV_DEBUG,
): DesktopBuildProfile {
  return devMode || tauriEnvDebug?.trim().toLowerCase() === "true"
    ? "debug"
    : "release";
}
