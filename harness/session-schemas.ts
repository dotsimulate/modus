import { z } from "zod";
import { McpServerConfigSchema } from "./profile-schemas";

const EffortSchema = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);
const ToolStateSchema = z.enum(["inherit", "on", "off"]);

const AttachmentSchema = z.object({
  type: z.literal("image"),
  mediaType: z.string(),
  data: z.string(),
  name: z.string().optional(),
});

const SessionSharedSchema = z.object({
  profile: z.string().optional(),
  userProfile: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  toolStates: z.record(z.string(), ToolStateSchema).optional(),
  effort: EffortSchema.optional(),
  cwd: z.string().optional(),
  additionalDirectories: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  providerControls: z.record(z.string(), z.unknown()).optional(),
  loadProjectSettings: z.boolean().optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
});

const MoveBindingSchema = z.object({
  name: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

export const CreateSessionRequestSchema = SessionSharedSchema.extend({
  prompt: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
  maxTurns: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
  moves: z.array(MoveBindingSchema).optional(),
  /** Profile move bindings the user removed in the composer before sending. */
  skipProfileMoves: z.array(z.string()).optional(),
});

export const SendMessageRequestSchema = SessionSharedSchema.extend({
  prompt: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
  maxTurns: z.number().int().positive().optional(),
  moves: z.array(MoveBindingSchema).optional(),
});

const PermissionModeSchema = z.enum(["bypass", "interactive"]).optional();

export const InteractRequestSchema = SessionSharedSchema.extend({
  sessionId: z.string().optional(),
  prompt: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
  moves: z.array(MoveBindingSchema).optional(),
  maxTurns: z.number().int().positive().optional(),
  subscribe: z.boolean().optional().default(true),
  createIfMissing: z.boolean().optional().default(true),
  permissionMode: PermissionModeSchema,
});

export const UpdateSessionConfigRequestSchema = SessionSharedSchema.extend({
  maxTurns: z.number().int().positive().nullable().optional(),
});
