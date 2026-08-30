/**
 * `${settings.key}` in an action's `provider` or `model`, resolved against the
 * owning plugin's settings.
 *
 * Kept separate from expandPluginValue, which runs at *load* time: settings
 * change through the settings API without an action reload, so a value that
 * tracks a setting has to be resolved when the action fires or it would serve
 * whatever was configured at boot.
 *
 * Deliberately whole-string only, and deliberately not a general templating
 * feature. A provider or model is the entire value, and matching the whole
 * string means an unresolved reference is visibly unresolved rather than a
 * half-substituted model id that gets sent to an API and fails obscurely. An
 * unresolved reference returns undefined so resolution falls through to the
 * agent profile, which is the same precedence resolveOneShotTarget already uses.
 *
 * Its own module rather than a function in action-runner.ts so a test can reach
 * it without importing the runner, which opens the database at module load.
 */

const SETTINGS_REFERENCE = /^\$\{settings\.([A-Za-z_][A-Za-z0-9_.-]*)\}$/;

export type SettingsReader = { get<T = unknown>(key: string): T | undefined };

export function resolveActionSettingReference(
  value: string | undefined,
  settings: SettingsReader,
  onUnresolved?: (key: string) => void,
): string | undefined {
  if (!value) return value;
  const match = SETTINGS_REFERENCE.exec(value);
  if (!match) return value;
  const key = match[1]!;
  const resolved = settings.get(key);
  if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
  onUnresolved?.(key);
  return undefined;
}
