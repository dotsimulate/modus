/** Shared backend/SDK identity for how an action prompt was answered. */
export type ActionAnswerer = "session" | "completion";

/** Telemetry persisted only when an action used the completion answerer. */
export interface ActionCompletionMetadata {
  oneShotId: string;
  provider: string;
  model: string;
  transport: "in-process" | "subprocess";
  elapsedMs: number;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
    costUsd: number;
  };
  stopReason?: string;
}
