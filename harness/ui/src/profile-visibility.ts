import type { Profile, UserProfile } from "../../sdk/index";

type ProfileIdentity = Pick<Profile, "name" | "displayName" | "origin">;
type ProfileVisibility = Pick<UserProfile, "agentProfiles" | "hiddenPluginProfiles">;

export function visibleAgentProfiles<T extends ProfileIdentity>(
  profiles: T[],
  userProfile?: ProfileVisibility | null,
): T[] {
  const hidden = new Set(userProfile?.hiddenPluginProfiles ?? []);
  const allowed = userProfile?.agentProfiles;
  return allowed?.length
    ? profiles.filter(profile =>
        profile.origin === "project"
        || (profile.origin === "plugin" && !hidden.has(profile.name))
        || allowed.includes(profile.name)
        || (!!profile.displayName && allowed.includes(profile.displayName)))
    : profiles.filter(profile => profile.origin !== "plugin" || !hidden.has(profile.name));
}

type MoveProfileClient = {
  listProfiles(cwd?: string): Promise<ProfileIdentity[]>;
  getUserProfile(name: string): Promise<ProfileVisibility>;
};

// The field renderer and the submit resolver share in-flight lookups, but reopening
// a form fetches again so profiles authored since the last open can appear.
const pending = new WeakMap<MoveProfileClient, Map<string, Promise<string[]>>>();

export function loadMoveProfileNames(client: MoveProfileClient, cwd: string, userProfile?: string): Promise<string[]> {
  let requests = pending.get(client);
  if (!requests) {
    requests = new Map();
    pending.set(client, requests);
  }
  const key = JSON.stringify([cwd, userProfile]);
  const existing = requests.get(key);
  if (existing) return existing;
  const request = Promise.all([
    client.listProfiles(cwd),
    userProfile ? client.getUserProfile(userProfile) : Promise.resolve(undefined),
  ]).then(([profiles, visibility]) => [
    "Current profile",
    ...visibleAgentProfiles(profiles, visibility).map(profile => profile.name),
  ]).finally(() => { requests.delete(key); });
  requests.set(key, request);
  return request;
}
