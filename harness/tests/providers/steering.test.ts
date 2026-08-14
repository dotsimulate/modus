import { resolve as resolveTestSourceDir } from "node:path";
/**
 * Steering is the one provider capability a client must know about *before* it
 * sends: the difference between "the agent reads this at the next tool boundary"
 * and "the agent reads this whenever the current turn happens to end". The
 * answer is declared in provider-names.ts and surfaced as
 * `ProviderCapabilities.messageDelivery`.
 *
 * A declaration that drifts from the implementation is worse than no
 * declaration, because the UI offers an affordance that silently does something
 * else. These tests pin the two together. They scan source rather than import
 * `registry.ts`, which pulls every provider implementation and transitively the
 * database.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  HIDDEN_LEGACY_PROVIDERS,
  STANDALONE_PROVIDERS,
  listPiProviders,
  listProviders,
  listSteerableProviders,
  supportsSteering,
} from "../../providers/provider-names";

const PI_PROVIDERS = listPiProviders();
const STEERABLE_PROVIDERS = listSteerableProviders();

/** Provider name → the file implementing it. PI backs all of its names with one module. */
const IMPLEMENTATION: Record<string, string> = {
  "claude-code": "claude-code.ts",
  "claude-code-pty": "claude-code-pty.ts",
  "codex": "codex.ts",
  "cursor": "cursor.ts",
  "antigravity": "antigravity.ts",
  "grok-build": "grok-build.ts",
  "opencode": "opencode.ts",
  "gemini-cli": "gemini-cli.ts",
  ...Object.fromEntries(PI_PROVIDERS.map((name) => [name, "pi-agent.ts"])),
};

function implementsSteerMessage(providerName: string): boolean {
  const file = IMPLEMENTATION[providerName];
  if (!file) throw new Error(`no implementation mapped for provider "${providerName}"`);
  const source = readFileSync(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), file), "utf-8");
  // The interface member, not a call or a comment mentioning it.
  return /^\s*steerMessage\s*\(/m.test(source);
}

describe("provider steering capability", () => {
  test("every provider declared steerable actually implements steerMessage", () => {
    const declaredButMissing = STEERABLE_PROVIDERS.filter((name) => !implementsSteerMessage(name));
    expect(declaredButMissing).toEqual([]);
  });

  test("no provider implements steerMessage without being declared steerable", () => {
    // The inverse matters just as much: an implementation nobody knows about is
    // dead code, because session-manager only reaches for it after the
    // capability check a client made.
    const implementedButUndeclared = Object.keys(IMPLEMENTATION)
      .filter((name) => implementsSteerMessage(name))
      .filter((name) => !supportsSteering(name));
    expect(implementedButUndeclared).toEqual([]);
  });

  test("providers that cannot steer are named, not merely absent", () => {
    // Guards against a new provider silently defaulting into either bucket.
    for (const name of ["codex", "cursor", "antigravity", "grok-build", "opencode", "gemini-cli"]) {
      expect(supportsSteering(name)).toBe(false);
    }
    for (const name of ["claude-code", "claude-code-pty", ...PI_PROVIDERS]) {
      expect(supportsSteering(name)).toBe(true);
    }
  });

  test("every steerable name is a real provider name", () => {
    const known = new Set<string>([...listProviders(), ...HIDDEN_LEGACY_PROVIDERS]);
    for (const name of STEERABLE_PROVIDERS) {
      expect(known.has(name)).toBe(true);
    }
  });

  test("every registered provider is mapped to an implementation file", () => {
    // Keeps this suite honest as providers are added: an unmapped name would
    // otherwise be skipped by both directions of the check above.
    for (const name of [...STANDALONE_PROVIDERS, ...PI_PROVIDERS, ...HIDDEN_LEGACY_PROVIDERS]) {
      expect(IMPLEMENTATION[name]).toBeDefined();
    }
  });
});
