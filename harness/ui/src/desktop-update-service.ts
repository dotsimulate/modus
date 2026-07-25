import {
  checkDesktopUpdate,
  installPendingDesktopUpdate,
  isTauriRuntime,
  type DesktopUpdateCheck,
} from "./desktopBridge";
import { recordUpdateCheck } from "./update-policy";

export type DesktopUpdateState = {
  status: "idle" | "checking" | "available" | "unavailable" | "installing" | "error";
  update?: DesktopUpdateCheck;
  error?: string;
};

let state: DesktopUpdateState = { status: "idle" };
const listeners = new Set<(next: DesktopUpdateState) => void>();

function publish(next: DesktopUpdateState): DesktopUpdateState {
  state = next;
  for (const listener of listeners) listener(next);
  return next;
}

export function getDesktopUpdateState(): DesktopUpdateState {
  return state;
}

export function subscribeDesktopUpdateState(listener: (next: DesktopUpdateState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export async function checkForDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!isTauriRuntime()) return publish({ status: "unavailable", error: "Updates are available only in the native app" });
  if (state.status === "checking" || state.status === "installing") return state;
  publish({ status: "checking" });
  try {
    const update = await checkDesktopUpdate();
    recordUpdateCheck();
    if (!update.configured) return publish({ status: "unavailable", update, error: "This build has no signed update channel" });
    return publish({ status: update.available ? "available" : "idle", update });
  } catch (caught: unknown) {
    return publish({ status: "error", error: caught instanceof Error ? caught.message : String(caught) });
  }
}

/** Must only be called after an explicit user confirmation in the UI. */
export async function installCheckedDesktopUpdate(): Promise<DesktopUpdateState> {
  if (state.status !== "available" || !state.update?.available) {
    return publish({ status: "error", error: "No checked update is pending" });
  }
  const update = state.update;
  publish({ status: "installing", update });
  try {
    await installPendingDesktopUpdate();
    return state;
  } catch (caught: unknown) {
    return publish({ status: "error", update, error: caught instanceof Error ? caught.message : String(caught) });
  }
}

