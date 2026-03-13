import { z } from "zod";

const EffortSchema = z.enum(["off", "low", "medium", "high", "max"]);
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
});

export const CreateSessionRequestSchema = SessionSharedSchema.extend({
  prompt: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
  maxTurns: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
});

export const SendMessageRequestSchema = SessionSharedSchema.extend({
  prompt: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const UpdateSessionConfigRequestSchema = SessionSharedSchema.extend({
  maxTurns: z.number().int().positive().nullable().optional(),
});
