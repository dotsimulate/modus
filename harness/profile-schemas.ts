/**
 * Zod schemas for profile validation.
 * Mirrors the TypeScript types in profiles.ts — enforced at runtime on API writes.
 */

import { z } from "zod";

// ── MCP Server Config ──

const McpStdioSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const McpSseSchema = z.object({
  type: z.literal("sse"),
  url: z.string(),
  headers: z.record(z.string()).optional(),
});

const McpHttpSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string()).optional(),
});

const McpServerConfigSchema = z.union([McpStdioSchema, McpSseSchema, McpHttpSchema]);

// ── Permission Policy ──

const PermissionPolicyObjectSchema = z.object({
  default: z.enum(["approve", "ask"]),
  autoApprove: z.array(z.string()).optional(),
  requireApproval: z.array(z.string()).optional(),
});

const PermissionPolicySchema = z.union([
  z.literal("bypass"),
  z.literal("ask"),
  PermissionPolicyObjectSchema,
]);

// ── Profile UI ──

const ProfileUiSchema = z.object({
  label: z.string().optional(),
  showThinking: z.boolean().optional(),
  showMeta: z.boolean().optional(),
  showToolCalls: z.boolean().optional(),
  placeholder: z.string().optional(),
  emptyTitle: z.string().optional(),
  emptySubtitle: z.string().optional(),
});

// ── Agent Profile ──

export const ProfileSchema = z.object({
  prompt: z.string(),
  description: z.string(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  loadProjectSettings: z.boolean().optional(),
  promptMode: z.enum(["custom", "append"]).optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  permissionPolicy: PermissionPolicySchema.optional(),
  ui: ProfileUiSchema.optional(),
});

// ── User Profile ──

const UserProfileMemorySchema = z.object({
  scope: z.enum(["global", "profile"]),
  inheritGlobal: z.boolean().optional(),
});

export const UserProfileSchema = z.object({
  displayName: z.string(),
  templateVars: z.record(z.string()).optional(),
  projects: z.array(z.string()),
  agentProfiles: z.array(z.string()).optional(),
  memoryFilter: z.string().optional(),
  memory: UserProfileMemorySchema.optional(),
  showAllProjectPaths: z.boolean().optional(),
});

// ── Global Config ──

export const GlobalConfigSchema = z.object({
  mcpServers: z.record(McpServerConfigSchema).optional(),
});

// ── Helpers ──

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/** Validate data against a schema, returning ok or error strings.
 *  On success the original data is used as-is (caller keeps their type). */
export function validate(schema: z.ZodType, data: unknown): ValidationResult {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true };
  const errors = result.error.issues.map(
    (i) => `${i.path.join(".")}: ${i.message}`
  );
  return { ok: false, errors };
}
