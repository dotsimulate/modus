/**
 * A move that fails to load injects nothing while its chip attaches normally, so
 * the user's only signal is an agent that ignores the context it was promised.
 * These failures are now classified and reported into the transcript, which
 * makes the sanitizer a security boundary: the detail comes from an authored
 * move's exception and is about to be persisted into a session that may be
 * exported or shared.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import {
  describeMoveActivationFailure,
  formatMoveActivationFailures,
  redactPaths,
  sanitizeFailureDetail,
  type MoveActivationFailure,
} from "../move-activation-failure";

const HARNESS_DIR = resolve(import.meta.dir, "..");

describe("failure detail sanitizing", () => {
  test("a stack trace is reduced to its first line", () => {
    const error = new Error("Cannot find module 'chess.js'");
    error.stack = "Error: Cannot find module 'chess.js'\n    at loadMoveModule (move-runner.ts:1300:19)";
    expect(sanitizeFailureDetail(error)).toBe("Cannot find module 'chess.js'");
  });

  test("a Windows absolute path is reduced to its final segment", () => {
    const detail = sanitizeFailureDetail(
      new Error("Failed to import D:\\Users\\someone\\projects\\secret-client\\.modus\\moves\\x\\context.ts"),
    );
    expect(detail).not.toContain("someone");
    expect(detail).not.toContain("secret-client");
    expect(detail).toContain("context.ts");
  });

  test("a POSIX absolute path is reduced to its final segment", () => {
    const detail = sanitizeFailureDetail(new Error("ENOENT: /home/someone/work/acme/.modus/moves/x/context.ts"));
    expect(detail).not.toContain("someone");
    expect(detail).not.toContain("acme");
    expect(detail).toContain("context.ts");
  });

  test("multiple paths in one message are all redacted", () => {
    const out = redactPaths("copy C:\\Users\\a\\one.ts to /home/b/two.ts");
    expect(out).not.toContain("Users");
    expect(out).not.toContain("home");
    expect(out).toContain("one.ts");
    expect(out).toContain("two.ts");
  });

  test("an ordinary message with no path is left intact", () => {
    expect(sanitizeFailureDetail(new Error("gather timed out after 15000ms")))
      .toBe("gather timed out after 15000ms");
  });

  test("the detail is length-capped", () => {
    const detail = sanitizeFailureDetail(new Error("x".repeat(5000)));
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail.endsWith("…")).toBe(true);
  });

  test("non-Error throws are handled", () => {
    expect(sanitizeFailureDetail("plain string failure")).toBe("plain string failure");
    expect(sanitizeFailureDetail({ message: "object with message" })).toBe("object with message");
    expect(sanitizeFailureDetail(undefined)).toBe("no reason reported");
    expect(sanitizeFailureDetail(null)).toBe("no reason reported");
    expect(sanitizeFailureDetail(new Error("   "))).toBe("no reason reported");
  });
});

describe("failure classification", () => {
  test("a reason without an error gets a stated phrase, not an empty detail", () => {
    const failure = describeMoveActivationFailure("chess", "not-found");
    expect(failure).toEqual({
      moveName: "chess",
      reason: "not-found",
      detail: "was not found in this project",
    });
  });

  test("a reason with an error carries the sanitized message", () => {
    const failure = describeMoveActivationFailure("chess", "gather-failed", new Error("board is undefined"));
    expect(failure.reason).toBe("gather-failed");
    expect(failure.detail).toBe("board is undefined");
  });
});

describe("the reported message", () => {
  test("no failures produce no message", () => {
    expect(formatMoveActivationFailures([])).toBe("");
  });

  test("the message says what did not happen, not just what failed", () => {
    // The user cannot deduce this: the chip attached and the turn ran normally.
    const message = formatMoveActivationFailures([
      { moveName: "chess", reason: "load-failed", detail: "Cannot find module 'chess.js'" },
    ]);
    expect(message).toContain("no context was injected");
    expect(message).toContain("chess");
    expect(message).toContain("failed to load its context.ts");
    expect(message).toContain("Cannot find module 'chess.js'");
  });

  test("each failure is listed and the count agrees", () => {
    const failures: MoveActivationFailure[] = [
      { moveName: "chess", reason: "load-failed", detail: "boom" },
      { moveName: "wordle", reason: "gather-empty", detail: "gathered no context" },
    ];
    const message = formatMoveActivationFailures(failures);
    expect(message).toContain("2 attached moves did not run");
    expect(message).toContain("chess");
    expect(message).toContain("wordle");
  });

  test("a stated phrase is not repeated as its own detail", () => {
    const message = formatMoveActivationFailures([describeMoveActivationFailure("ghost", "not-found")]);
    expect(message).toContain("was not found in this project");
    // Not "... was not found in this project — was not found in this project".
    expect(message.match(/was not found in this project/g)).toHaveLength(1);
  });
});

describe("the runtime reports failures rather than swallowing them", () => {
  // The defect this closes is a `catch` that only reached the console, so the
  // guard is that every failure branch records into the result.
  const moveRunner = readFileSync(join(HARNESS_DIR, "move-runner.ts"), "utf-8");
  const sessionManager = readFileSync(join(HARNESS_DIR, "session-manager.ts"), "utf-8");

  test("every activation failure branch records a classified failure", () => {
    for (const reason of ["not-found", "activation-failed", "gather-failed", "gather-empty", "load-failed"]) {
      expect(moveRunner).toContain(`"${reason}"`);
    }
  });

  test("a load failure is distinguished from an absent gather()", () => {
    // Both arrive at the same branch as `null`, and reporting an import error as
    // "this move injects nothing" would send the author looking in the wrong place.
    expect(moveRunner).toContain("getMoveLoadError(spec.name, cwd)");
  });

  test("the session surfaces the failures instead of only logging them", () => {
    expect(sessionManager).toContain("reportMoveActivationFailures(session,");
    expect(sessionManager).toContain("formatMoveActivationFailures(failures)");
  });
});
