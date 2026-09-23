/** Finite, trusted-local operations. These declarations are also used by the SDK. */
export type ActionInputField = {
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  default?: string | number | boolean;
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};

/** Deliberately small JSON Schema subset shared by all invocation surfaces. */
export type ActionInputSchema = {
  type: "object";
  properties: Record<string, ActionInputField>;
  required?: string[];
  additionalProperties?: false;
};

export type ActionCommand = {
  executable: string;
  /** An input reference inserts one argument, never shell text. */
  args?: Array<string | { input: string }>;
  /** Explicit shell program and script. Cannot be combined with args. */
  shell?: boolean;
};

export type ActionOperation =
  | ({ type: "command" } & ActionCommand)
  | { type: "code" };

export type OperationArtifact = { name: string; path: string; mime: string };
export type OperationResult = {
  summary?: string;
  data?: unknown;
  artifacts?: OperationArtifact[];
};

export type ProcessResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type OperationReceipt = {
  version: 1;
  runId: number;
  parentRunId?: number;
  caller: string;
  fingerprint: string;
  target: "backend";
  cwd: string;
  inputs: Record<string, unknown>;
  command?: { executable: string; args: string[]; shell: boolean };
  outcome: "running" | "succeeded" | "failed" | "could-not-start" | "timed-out" | "cancelled" | "interrupted" | "skipped";
  exitCode?: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  result?: OperationResult;
};

/** Only these operations cross the worker boundary; no harness internals are imported. */
export interface CodeActionContext {
  runId: number;
  actionName: string;
  inputs: Record<string, unknown>;
  trigger: { type: string; payload?: unknown; source?: string };
  cwd: string;
  signal: AbortSignal;
  log(message: string): void;
  process: {
    run(options: { executable: string; args?: string[]; cwd?: string; check?: boolean }): Promise<ProcessResult>;
  };
  artifacts: { path(filename: string): string };
  secrets: { resolve(reference: string): Promise<string | undefined> };
  actions: { trigger(name: string, inputs?: Record<string, unknown>): Promise<void> };
  sessions: { create(options: { profile: string; prompt: string }): Promise<unknown> };
}

export interface CodeActionModule {
  run(ctx: CodeActionContext): Promise<OperationResult | void>;
}
