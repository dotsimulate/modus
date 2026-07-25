export type UpdateUrgency = "normal" | "recommended" | "critical";

export const UPDATE_CHECKS_ENABLED_KEY = "modus:update-checks-enabled";
export const LAST_UPDATE_CHECK_KEY = "modus:last-update-check";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export function parseUpdateUrgency(notes?: string | null): UpdateUrgency {
  const match = notes?.match(/(?:\[|<!--\s*)modus-update:(normal|recommended|critical)(?:\]|\s*-->)/i);
  return (match?.[1]?.toLowerCase() as UpdateUrgency | undefined) ?? "normal";
}

export function automaticUpdateChecksEnabled(storage: ReadStorage = localStorage): boolean {
  return storage.getItem(UPDATE_CHECKS_ENABLED_KEY) === "true";
}

export function setAutomaticUpdateChecksEnabled(enabled: boolean, storage: WriteStorage = localStorage): void {
  storage.setItem(UPDATE_CHECKS_ENABLED_KEY, String(enabled));
}

export function recordUpdateCheck(now = Date.now(), storage: WriteStorage = localStorage): void {
  storage.setItem(LAST_UPDATE_CHECK_KEY, String(now));
}

export function shouldCheckForUpdates(options: {
  nativeDesktop: boolean;
  enabled: boolean;
  now?: number;
  storage?: ReadStorage;
}): boolean {
  if (!options.nativeDesktop || !options.enabled) return false;
  const now = options.now ?? Date.now();
  const last = Number((options.storage ?? localStorage).getItem(LAST_UPDATE_CHECK_KEY) ?? "0");
  return !Number.isFinite(last) || last <= 0 || now - last >= UPDATE_CHECK_INTERVAL_MS;
}

