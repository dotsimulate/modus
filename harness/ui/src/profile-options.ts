import type { Profile } from "../../sdk";

/** Clean label plus a compact source marker; qualified keys stay internal. */
export function profileOptionLabel(profile: Profile): string {
  const label = profile.displayName ?? profile.name;
  if (profile.origin === "plugin") {
    return `${label} · ${profile.pluginName ?? profile.pluginId ?? "plugin"}`;
  }
  if (profile.origin === "project") return `${label} · project`;
  return label;
}

export function profileOptions(profiles: Profile[]) {
  return profiles.map((profile) => ({
    value: profile.name,
    label: profileOptionLabel(profile),
  }));
}
