import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import {
  attachPipeErrorHandler,
  isExpectedPipeError,
  pipeErrorCode,
  tryPipeOperation,
} from "./pipe-errors";

describe("pipe error containment", () => {
  test("recognizes expected closed-stream errors without exposing messages", () => {
    const error = Object.assign(new Error("credential-shaped private detail"), { code: "EPIPE" });
    expect(pipeErrorCode(error)).toBe("EPIPE");
    expect(isExpectedPipeError(error)).toBe(true);
    expect(isExpectedPipeError(Object.assign(new Error("other"), { code: "EINVAL" }))).toBe(false);
  });

  test("contains EventEmitter error events even when the local handler fails", () => {
    const stream = new EventEmitter();
    let observed = 0;
    const detach = attachPipeErrorHandler(stream, () => {
      observed++;
      throw new Error("handler failure");
    });

    expect(() => stream.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }))).not.toThrow();
    expect(observed).toBe(1);
    detach();
  });

  test("turns synchronous pipe failures into a false result", () => {
    let observed = "";
    const ok = tryPipeOperation(
      () => { throw Object.assign(new Error("closed"), { code: "ERR_STREAM_DESTROYED" }); },
      (error) => { observed = pipeErrorCode(error); },
    );
    expect(ok).toBe(false);
    expect(observed).toBe("ERR_STREAM_DESTROYED");
  });
});

