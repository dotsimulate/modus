/**
 * Classifying a filesystem mutation failure.
 *
 * The file-write/file-create/dir-create routes used to let an fs rejection
 * escape the handler, and the SDK collapsed every outcome to `response.ok`. A
 * UI could therefore tell the user only that "saving failed" — never that the
 * name was taken, that the directory is read-only, or that the harness lacks
 * permission, which are three different things for the person to do next.
 *
 * This module is imported by the route handlers and by the SDK types, so it has
 * no imports of its own — and the routes live in index.ts, which starts a server
 * on import, so the classification has to live out here to be testable at all.
 */

/** Why a filesystem mutation failed, as a stable string the UI can branch on. */
export type FileMutationErrorCode =
  /** The path already exists. The caller asked to create, not to overwrite. */
  | "collision"
  /** The OS refused: EACCES/EPERM. */
  | "denied"
  /** The filesystem is mounted read-only: EROFS. */
  | "read-only"
  /** A parent directory in the path does not exist: ENOENT. */
  | "missing-parent"
  /** A path component exists but is not a directory: ENOTDIR. */
  | "not-a-directory"
  /** The volume is full: ENOSPC. */
  | "no-space"
  /** The request itself was malformed — a missing path or content. */
  | "rejected"
  /** The caller did not satisfy the file API auth gate. */
  | "unauthorized"
  /** Anything else. `error` still carries the underlying message. */
  | "failed";

export type FileMutationFailure = {
  code: FileMutationErrorCode;
  error: string;
  status: 400 | 403 | 404 | 409 | 507 | 500;
};

/** The outcome of a filesystem mutation through the SDK.
 *
 *  **Always inspect `ok`.** The object is truthy on failure too, so a caller
 *  that treats the return value itself as a boolean silently succeeds forever —
 *  which is why these methods used to return a bare boolean and why changing
 *  them meant visiting every call site rather than trusting the typechecker. */
export type FileMutationResult = {
  ok: boolean;
  /** The absolute path the server resolved, on success. */
  path?: string;
  /** Present only on failure. */
  code?: FileMutationErrorCode;
  /** Present only on failure. Written for a person to read. */
  error?: string;
};

/** Turn a route response into a result. Kept beside the server-side mapping so
 *  the two halves of the contract cannot drift, and pure so it is testable
 *  without a live harness. */
export function readFileMutationResponse(status: number, body: unknown): FileMutationResult {
  const payload = (typeof body === "object" && body !== null ? body : {}) as {
    ok?: unknown; path?: unknown; code?: unknown; error?: unknown;
  };
  if (status >= 200 && status < 300) {
    return { ok: true, path: typeof payload.path === "string" ? payload.path : undefined };
  }
  const code: FileMutationErrorCode = typeof payload.code === "string"
    ? payload.code as FileMutationErrorCode
    : statusFallbackCode(status);
  const error = typeof payload.error === "string" && payload.error
    ? payload.error
    : `request failed with status ${status}`;
  return { ok: false, code, error };
}

/** A response with no `code` still has a status. An older harness predates the
 *  code field entirely, so the status has to keep carrying the distinction the
 *  UI branches on. */
function statusFallbackCode(status: number): FileMutationErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "missing-parent";
  if (status === 409) return "collision";
  if (status === 400) return "rejected";
  return "failed";
}

const BY_ERRNO: Record<string,{ code: FileMutationErrorCode; status: FileMutationFailure["status"]; describe: (path: string) => string }> = {
  EACCES: { code: "denied", status: 403, describe: (p) => `permission denied writing ${p}` },
  EPERM: { code: "denied", status: 403, describe: (p) => `permission denied writing ${p}` },
  EROFS: { code: "read-only", status: 403, describe: (p) => `${p} is on a read-only filesystem` },
  ENOENT: { code: "missing-parent", status: 404, describe: (p) => `a parent directory of ${p} does not exist` },
  ENOTDIR: { code: "not-a-directory", status: 409, describe: (p) => `a path component of ${p} is not a directory` },
  EEXIST: { code: "collision", status: 409, describe: (p) => `${p} already exists` },
  ENOSPC: { code: "no-space", status: 507, describe: (p) => `no space left on the volume holding ${p}` },
};

/** Map a thrown filesystem error onto a code, a message, and an HTTP status.
 *
 *  The errno is the signal, not the message text — a message is localized and
 *  varies between Windows and POSIX, whereas `err.code` does not. An unmapped
 *  error keeps its own message rather than being flattened, so a cause nobody
 *  anticipated still reaches the user instead of becoming "failed". */
export function fileMutationFailure(err: unknown, path: string): FileMutationFailure {
  const errno = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
  const mapped = BY_ERRNO[errno];
  if (mapped) return { code: mapped.code, error: mapped.describe(path), status: mapped.status };
  const message = err instanceof Error && err.message ? err.message : `could not write ${path}`;
  return { code: "failed", error: message, status: 500 };
}
