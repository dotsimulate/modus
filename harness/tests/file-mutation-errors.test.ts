import { describe, expect, test } from "bun:test";
import { fileMutationFailure, readFileMutationResponse } from "../file-mutation-errors";

/** An fs rejection as Node/Bun actually throws it: the errno is on `code`. */
function fsError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("fileMutationFailure", () => {
  // The three the report named, because they are the three a user can act on:
  // rename it, fix permissions, or write somewhere else.
  test("permission, read-only, and collision are distinguishable", () => {
    expect(fileMutationFailure(fsError("EACCES", "EACCES: permission denied"), "/x/y").code).toBe("denied");
    expect(fileMutationFailure(fsError("EPERM", "EPERM: operation not permitted"), "/x/y").code).toBe("denied");
    expect(fileMutationFailure(fsError("EROFS", "EROFS: read-only file system"), "/x/y").code).toBe("read-only");
    expect(fileMutationFailure(fsError("EEXIST", "EEXIST: file already exists"), "/x/y").code).toBe("collision");
  });

  test("a missing parent is 404, not a generic failure", () => {
    const failure = fileMutationFailure(fsError("ENOENT", "ENOENT: no such file"), "/nope/deep/file.txt");
    expect(failure.code).toBe("missing-parent");
    expect(failure.status).toBe(404);
    expect(failure.error).toContain("/nope/deep/file.txt");
  });

  test("a full volume reports no-space rather than denied", () => {
    const failure = fileMutationFailure(fsError("ENOSPC", "ENOSPC: no space left on device"), "/x/y");
    expect(failure.code).toBe("no-space");
    expect(failure.status).toBe(507);
  });

  // The errno is the signal, not the text — messages are localized and differ
  // between Windows and POSIX, so a message-matching classifier would be wrong
  // on exactly the machines it matters on.
  test("classification reads the errno, not the message text", () => {
    const misleading = fsError("EACCES", "no such file or directory");
    expect(fileMutationFailure(misleading, "/x/y").code).toBe("denied");
  });

  test("an unmapped error keeps its own message instead of being flattened", () => {
    const failure = fileMutationFailure(fsError("EBUSY", "EBUSY: resource busy or locked"), "/x/y");
    expect(failure.code).toBe("failed");
    expect(failure.error).toBe("EBUSY: resource busy or locked");
    expect(failure.status).toBe(500);
  });

  test("a non-Error rejection still produces a usable failure", () => {
    const failure = fileMutationFailure("something threw a string", "/x/y");
    expect(failure.code).toBe("failed");
    expect(failure.error).toContain("/x/y");
  });
});

describe("readFileMutationResponse", () => {
  test("a 2xx carries the resolved path", () => {
    const result = readFileMutationResponse(200, { ok: true, path: "D:\\work\\notes" });
    expect(result).toEqual({ ok: true, path: "D:\\work\\notes" });
  });

  test("a coded failure passes the server's code and message through", () => {
    const result = readFileMutationResponse(403, { error: "/x is on a read-only filesystem", code: "read-only" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("read-only");
    expect(result.error).toBe("/x is on a read-only filesystem");
  });

  // The auth gate rejects before any route body exists, so its 401/403 has no
  // code — the status has to keep carrying that distinction.
  test("an uncoded 401 reads as unauthorized", () => {
    expect(readFileMutationResponse(401, { error: "unauthorized" }).code).toBe("unauthorized");
  });

  test("an uncoded 409 still reads as a collision", () => {
    expect(readFileMutationResponse(409, { error: "already exists" }).code).toBe("collision");
  });

  // A proxy error page or a truncated response must not throw out of the SDK.
  test("a non-JSON body still yields a failure with a message", () => {
    const result = readFileMutationResponse(502, null);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("failed");
    expect(result.error).toContain("502");
  });
});
