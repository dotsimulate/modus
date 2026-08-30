/**
 * Authored setting declarations — the one description of a setting an author
 * writes into a client-extension manifest or a plugin manifest.
 *
 * Three surfaces read these shapes: backend discovery decides where a value is
 * stored and whether it is legal, the SDK types describe what an author may
 * write, and the settings UI renders the control. They used to be declared
 * separately and drifted — `textarea` and `secret-name` shipped on the SDK side
 * while backend discovery still typed the field as string|number|boolean|select,
 * and `rows` existed only on the SDK copy though the renderer read it. Declaring
 * them once is what stops the next field from doing the same.
 *
 * These are TypeScript shapes, not Zod schemas — an authored manifest is parsed
 * directly, the same way `move.json` is. Validation of a *value* against a
 * declaration lives in `settingNumberError` below and in plugin-settings.ts.
 *
 * This module is imported by the backend, the browser bundle, and the SDK types,
 * so it deliberately has no imports of its own.
 */

// ── Client extension settings ──

/**
 * `textarea` and `secret-name` exist because the sibling primitives already had
 * them and extensions did not inherit either: move inputs support `textarea`,
 * and `PluginSettingDefinition` supports `secret-name`. A multi-line setting (a
 * vocabulary list, a phrase map) is unusable in a single-line input, and a
 * setting that names a Modus secret should say so rather than looking like free
 * text — extension settings are served by `GET /api/client-extensions`, so the
 * distinction between "names a secret" and "holds a secret" is load-bearing.
 */
export type ExtensionSettingType =
  | "string"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "secret-name";

/** Where an extension setting is stored and resolved.
 *
 *  "user" values describe the client doing the talking — local hardware, a
 *  per-device preference — so they belong to that client's user profile and are
 *  allowed to differ between a desktop and a phone.
 *
 *  "global" values are consumed by the harness itself. They must be identical
 *  for every client attached to this Vault, so they are stored Vault-wide and resolved without the
 *  user-profile layer. Storing one per profile means a client that never opened
 *  the settings form silently resolves nothing — which is how a missing whisper
 *  endpoint surfaced as an unexplained 502 on every phone. */
export type ExtensionSettingScope = "user" | "global";

export type ExtensionSettingSchema = {
  type: ExtensionSettingType;
  label: string;
  description?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  /** Rows for a `textarea` field. Default 4. */
  rows?: number;
  /** Inclusive bound for a `number` field. Ignored by every other type. */
  min?: number;
  /** Inclusive bound for a `number` field. Ignored by every other type. */
  max?: number;
  /** Granularity for a `number` field's stepper. Ignored by every other type. */
  step?: number;
  /** Where the value is stored. "user" (default) is per user profile, so it may
   *  differ between a desktop and a phone — right for local hardware, wrong for
   *  anything the harness itself consumes. "global" is stored once for the
   *  machine and resolved without the user-profile layer, so every client agrees
   *  on it. */
  scope?: ExtensionSettingScope;
};

/** Metadata declared by a client extension module (name, description, configurable settings). */
export type ExtensionMeta = {
  name?: string;
  description?: string;
  settings?: Record<string, ExtensionSettingSchema>;
};

/** Mirrors plugin settings: an undeclared scope is per user profile. */
export function extensionSettingScope(def: ExtensionSettingSchema): ExtensionSettingScope {
  return def.scope === "global" ? "global" : "user";
}

// ── Plugin settings ──

export type PluginSettingScope = "user" | "project" | "global";

/**
 * `provider` and `model` are pickers over live data rather than authored option
 * lists. A shipped `select` would have to name models in JSON, and a model name
 * baked into shipped content is stale by the next release — the list a user
 * should choose from is the one their configured provider answers with today.
 * The value stored is still just a string, so nothing downstream has to care.
 *
 * `model` reads `providerSetting` to know whose catalogue to list; that names
 * another setting key on the same plugin, not a provider.
 */
export type PluginSettingType =
  | "string"
  | "number"
  | "toggle"
  | "select"
  | "project-list"
  | "secret-name"
  | "provider"
  | "model";

export type PluginSettingDefinition = {
  key: string;
  type: PluginSettingType;
  label?: string;
  description?: string;
  default?: unknown;
  scope?: PluginSettingScope;
  options?: Array<{ value: string; label: string }>;
  /** `provider` only: restrict the list to providers that can serve a one-shot completion. */
  oneShotOnly?: boolean;
  /** `model` only: the sibling setting key holding the provider to list models for. */
  providerSetting?: string;
  /** Inclusive bound for a `number` field. Ignored by every other type. */
  min?: number;
  /** Inclusive bound for a `number` field. Ignored by every other type. */
  max?: number;
  /** Granularity for a `number` field's stepper. Ignored by every other type. */
  step?: number;
};

// ── Numeric constraints ──

/** The declared numeric bounds of a setting, whichever kind declared them. */
export type NumericSettingConstraints = {
  min?: number;
  max?: number;
  step?: number;
};

/** Why `value` is not a legal number for `constraints`, or null when it is.
 *
 *  A browser input's `min`/`max` attributes are advisory — a client can PATCH
 *  any value it likes — so the same declaration has to be enforced on the write
 *  path. Returning the message rather than throwing lets each caller decide
 *  between a 400 and an exception. `step` is deliberately not enforced: it
 *  describes stepper granularity, and rejecting an off-step value the user typed
 *  deliberately is more annoying than useful. */
export function settingNumberError(
  key: string,
  value: unknown,
  constraints: NumericSettingConstraints,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${key} must be a finite number`;
  }
  if (constraints.min !== undefined && value < constraints.min) {
    return `${key} must be at least ${constraints.min}`;
  }
  if (constraints.max !== undefined && value > constraints.max) {
    return `${key} must be at most ${constraints.max}`;
  }
  return null;
}
