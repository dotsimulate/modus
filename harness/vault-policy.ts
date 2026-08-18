/** Per-Vault execution and egress policy. Read on every call: this file is
 * authored configuration, so edits must take effect without a process restart. */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { APP_PATHS, type AppPaths } from "./app-paths";
import type { VaultPolicy, VaultPolicyRule } from "./vault-types";

export type { VaultPolicy, VaultPolicyRule } from "./vault-types";

export type VaultPolicyPaths = Pick<AppPaths, "writableRoot" | "instance">;

export const DENY_ALL_POLICY: VaultPolicy = {
  plugins: { mode: "deny", allow: [] },
  projectAutomation: { mode: "deny", allow: [] },
  channels: { mode: "deny", allow: [] },
};

export const ALLOW_ALL_POLICY: VaultPolicy = {
  plugins: { mode: "allow-all" },
  projectAutomation: { mode: "allow-all" },
  channels: { mode: "allow-all" },
};

const POLICY_KEYS = ["plugins", "projectAutomation", "channels"] as const;

function cloneRule(rule: VaultPolicyRule): VaultPolicyRule {
  return rule.mode === "allow-all"
    ? { mode: "allow-all" }
    : { mode: "deny", allow: [...rule.allow] };
}

function clonePolicy(policy: VaultPolicy): VaultPolicy {
  return {
    plugins: cloneRule(policy.plugins),
    projectAutomation: cloneRule(policy.projectAutomation),
    channels: cloneRule(policy.channels),
  };
}

function defaultPolicy(paths: VaultPolicyPaths): VaultPolicy {
  return clonePolicy(paths.instance ? DENY_ALL_POLICY : ALLOW_ALL_POLICY);
}

function normalizeProjectCwd(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const absolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(trimmed) ? trimmed : resolve(trimmed);
  const slashed = absolute.replace(/\\/g, "/");
  const normalized = slashed === "/" ? "/" : slashed.replace(/\/+$/, "");
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function parseRule(value: unknown, normalizeAllow = false): VaultPolicyRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rule = value as Record<string, unknown>;
  if (rule.mode === "allow-all") return { mode: "allow-all" };
  if (rule.mode !== "deny" || !Array.isArray(rule.allow) || !rule.allow.every((item) => typeof item === "string")) {
    return null;
  }
  const allow = rule.allow as string[];
  return {
    mode: "deny",
    allow: normalizeAllow ? allow.map(normalizeProjectCwd) : [...allow],
  };
}

function parsePolicy(value: unknown, missing: VaultPolicy, requireEveryKey = false): VaultPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authored = value as Record<string, unknown>;
  const parsed = {} as VaultPolicy;

  for (const key of POLICY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(authored, key)) {
      if (requireEveryKey) return null;
      parsed[key] = cloneRule(missing[key]);
      continue;
    }
    const rule = parseRule(authored[key], key === "projectAutomation");
    if (!rule) return null;
    parsed[key] = rule;
  }
  return parsed;
}

/** Strict policy parser for API writes. Unknown keys are forward-compatible,
 * but every current boundary must be present and valid. */
export function parseVaultPolicy(value: unknown): VaultPolicy | null {
  return parsePolicy(value, DENY_ALL_POLICY, true);
}

function policyPath(paths: VaultPolicyPaths): string {
  return join(paths.writableRoot, "vault.json");
}

export function getVaultPolicy(paths: VaultPolicyPaths = APP_PATHS): VaultPolicy {
  const fallback = defaultPolicy(paths);
  try {
    const authored = JSON.parse(readFileSync(policyPath(paths), "utf8")) as unknown;
    return parsePolicy(authored, fallback) ?? clonePolicy(DENY_ALL_POLICY);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return fallback;
    return clonePolicy(DENY_ALL_POLICY);
  }
}

function ruleAllows(rule: VaultPolicyRule, value: string): boolean {
  return rule.mode === "allow-all" || rule.allow.includes(value);
}

export function isPluginAllowed(id: string, paths: VaultPolicyPaths = APP_PATHS): boolean {
  return ruleAllows(getVaultPolicy(paths).plugins, id);
}

export function isProjectAutomationAllowed(cwd: string, paths: VaultPolicyPaths = APP_PATHS): boolean {
  return ruleAllows(getVaultPolicy(paths).projectAutomation, normalizeProjectCwd(cwd));
}

export function isChannelAllowed(name: string, paths: VaultPolicyPaths = APP_PATHS): boolean {
  return ruleAllows(getVaultPolicy(paths).channels, name);
}

export function writeVaultPolicy(policy: VaultPolicy, paths: VaultPolicyPaths = APP_PATHS): void {
  const parsed = parseVaultPolicy(policy);
  if (!parsed) throw new Error("Invalid Vault policy");
  mkdirSync(paths.writableRoot, { recursive: true });
  writeFileSync(policyPath(paths), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}
