import type { OperationResult, ProcessResult } from "./action-operation-types";

export const ACTION_PROTOCOL_VERSION = 1;
export const ACTION_MESSAGE_LIMIT = 256 * 1024;
export const ACTION_LOG_LIMIT = 32 * 1024;
export type WorkerRequest = { version: 1; id: number; op: string; args: unknown };
export type WorkerMessage = WorkerRequest | {
  version: 1;
  type: "result";
  result?: OperationResult;
  process?: ProcessResult;
  error?: string;
  couldNotStart?: boolean;
};

export function boundedMessage(value: unknown): boolean {
  return JSON.stringify(value).length <= ACTION_MESSAGE_LIMIT;
}

export class ProcessExitError extends Error {
  constructor(public result: ProcessResult) {
    super(`Process exited with ${result.exitCode ?? result.signal ?? "unknown status"}`);
    this.name = "ProcessExitError";
  }
}

/** Keeps a bounded tail, including on a single enormous write. */
export class OutputTail {
  private buffer = Buffer.alloc(0);
  truncated = false;
  append(chunk: Buffer | string) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const size = this.buffer.length + bytes.length;
    if (size > ACTION_LOG_LIMIT) this.truncated = true;
    this.buffer = bytes.length >= ACTION_LOG_LIMIT
      ? Buffer.from(bytes.subarray(bytes.length - ACTION_LOG_LIMIT))
      : Buffer.concat([this.buffer.subarray(Math.max(0, size - ACTION_LOG_LIMIT)), bytes]);
  }
  text() { return this.buffer.toString("utf8"); }
}
