/**
 * Assembling the `PUT /api/profiles/:name` payload without truncating the file.
 *
 * The endpoint replaces the whole profile — `saveProfile` in `harness/profiles.ts` is a bare
 * `writeJson`, with no merge against what is on disk. So a payload built only from form state
 * deletes every field the form has no input for. Until 2026-08-20 that is exactly what
 * `ProfileEditor` sent, and saving a profile from the UI destroyed `permissionPolicy`, `moves`,
 * `skills`, `providerControls`, `ui`, `disallowedTools`, `additionalDirectories`,
 * `cwdSuggestions`, `env`, `plugins`, `sandbox`, `compaction`, and the rest — silently, with no
 * diff and no log. `permissionPolicy` is a security boundary: losing it drops the profile to the
 * `"bypass"` default in `providers/claude-code.ts`.
 *
 * The rule is that the form is a *partial* editor. It is authoritative for the fields it renders
 * and must carry everything else through untouched. This lives outside the component because the
 * repo has no DOM test environment — pinning it requires it to be pure.
 */

import type { Profile } from "../../sdk/index";

/**
 * Profile keys the editor renders, and therefore owns on save.
 *
 * A field belongs here only if the form can express *removing* it. Adding an input without
 * adding its key here makes the input a no-op; adding the key without an input deletes the field.
 */
export const FORM_MANAGED_FIELDS = [
  "description",
  "prompt",
  "promptMode",
  "provider",
  "model",
  "effort",
  "maxTurns",
  "tools",
  "loadProjectSettings",
  "mcpServers",
  "mcpConfig",
  "permissionPolicy",
] as const;

/**
 * Resolution metadata the server attaches when reading a profile.
 *
 * Not file content. `saveProfile` strips these anyway; dropping them here keeps them out of the
 * request body so they never reach schema validation.
 */
const DECORATION_FIELDS = [
  "name",
  "key",
  "displayName",
  "origin",
  "pluginId",
  "pluginName",
  "pluginPath",
  "path",
] as const;

const NON_PASSTHROUGH = new Set<string>([...FORM_MANAGED_FIELDS, ...DECORATION_FIELDS]);

/** Everything in a loaded profile that the form does not model and must not disturb. */
export function unmanagedProfileFields(profile: Partial<Profile>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(profile).filter(([key]) => !NON_PASSTHROUGH.has(key)),
  );
}

export type ProfileFormValues = {
  description: string;
  prompt: string;
  promptMode: "custom" | "append";
  loadProjectSettings: boolean;
  provider: string;
  model: string;
  effort: string;
  /** Raw text from a number input, so "" means "unset" rather than 0. */
  maxTurns: string;
  /**
   * Explicit built-in tool surface, or null to inherit the provider default.
   *
   * `[]` is a real, distinct value — the Claude Agent SDK documents an empty `tools` array as
   * "Disable all built-in tools". Collapsing it to null the way this form used to made "no tools"
   * unexpressible and, worse, silently identical to "every tool".
   */
  tools: string[] | null;
  mcpServers: Record<string, unknown>;
  mcpConfig?: string;
  permissionPolicy?: Profile["permissionPolicy"];
};

/**
 * Build the save payload: untouched fields first, form-owned fields last.
 *
 * Optional form fields are omitted rather than sent empty, because omission is how this schema
 * spells "inherit the default" — an empty `effort` or a zero `maxTurns` is not the same thing.
 * They are still *form-managed*, so omitting one deletes it from the file, which is what
 * clearing the input should mean.
 */
export function buildProfileSavePayload(
  original: Partial<Profile>,
  form: ProfileFormValues,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...unmanagedProfileFields(original),
    description: form.description,
    prompt: form.prompt,
    promptMode: form.promptMode,
    loadProjectSettings: form.loadProjectSettings,
  };
  if (form.provider) payload.provider = form.provider;
  if (form.model) payload.model = form.model;
  if (form.effort) payload.effort = form.effort;
  if (form.maxTurns) payload.maxTurns = Number(form.maxTurns);
  // Sent whenever it is an array, including empty — see `ProfileFormValues.tools`.
  if (form.tools !== null) payload.tools = form.tools;
  if (Object.keys(form.mcpServers).length > 0) payload.mcpServers = form.mcpServers;
  if (form.mcpConfig?.trim()) payload.mcpConfig = form.mcpConfig.trim();
  if (form.permissionPolicy !== undefined) payload.permissionPolicy = form.permissionPolicy;
  return payload;
}
