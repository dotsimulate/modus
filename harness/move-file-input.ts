/**
 * Validation for `file` move inputs.
 *
 * A file input resolves to an absolute host path that move code will open. The
 * picker constrains what a user can choose, but the picker is not the boundary:
 * `POST /api/moves/activate`, a page embed, a client extension and the SDK all
 * post `inputs` directly, so the value has to be re-checked where it is
 * consumed. This module is that check.
 *
 * The policy is deliberately narrow — inside the project root unless the move
 * opts out, and an extension allowlist when the move declares one. Symlink
 * escape is handled by resolving the real path before the containment test, so
 * a link inside the project pointing at `~/.ssh/id_rsa` does not pass.
 *
 * Pure apart from an injected `statFile`, so the rules are testable without a
 * filesystem.
 */

import { resolve } from "path";
import { isWithinRoot } from "./preview-roots";
import { extensionAllowed, normalizeExtension } from "./move-file-accept";
import type { MoveInput, MoveInputFilePolicy } from "./move-types";

// Re-exported so backend callers have one import for the whole contract; the
// frontend must import them from move-file-accept, which pulls in no `path`.
export { acceptsFileName, extensionAllowed, normalizeExtension } from "./move-file-accept";

export type MoveFileInputRejection =
  /** Required, but nothing was chosen. */
  | "empty"
  /** Resolves outside the project root and the move did not allow that. */
  | "outside-project"
  /** Extension is not in the move's accept list. */
  | "extension-not-allowed"
  /** Nothing exists at the path. */
  | "missing"
  /** Exists but is a directory, not a file. */
  | "not-a-file";

export type MoveFileInputCheck =
  | { ok: true; path: string }
  | { ok: false; reason: MoveFileInputRejection; message: string };

export interface FileStat {
  exists: boolean;
  isFile: boolean;
  /** The real path after resolving symlinks, when the caller can determine it. */
  realPath?: string;
}

/**
 * Check one file input value against a move's declared policy.
 *
 * `statFile` is injected: the harness passes a real filesystem probe, tests pass
 * a table. When it is omitted, existence is not asserted — containment and
 * extension rules still apply.
 */
export function validateMoveFileInput(
  rawValue: unknown,
  opts: {
    projectRoot: string;
    policy?: MoveInputFilePolicy;
    required?: boolean;
    statFile?: (path: string) => FileStat;
  },
): MoveFileInputCheck {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    return opts.required
      ? { ok: false, reason: "empty", message: "no file was selected" }
      : { ok: true, path: "" };
  }

  const resolved = resolve(value);
  const stat = opts.statFile?.(resolved);

  if (stat && !stat.exists) {
    return { ok: false, reason: "missing", message: "no such file" };
  }
  if (stat && stat.exists && !stat.isFile) {
    return { ok: false, reason: "not-a-file", message: "that path is a directory, not a file" };
  }

  // Containment is tested against the real path so a symlink inside the project
  // cannot be used to reach a file outside it.
  const effective = stat?.realPath ? resolve(stat.realPath) : resolved;
  if (!opts.policy?.allowOutsideProject && !isWithinRoot(effective, opts.projectRoot)) {
    return {
      ok: false,
      reason: "outside-project",
      message: "that file is outside this project",
    };
  }

  if (!extensionAllowed(effective, opts.policy?.accept)) {
    const allowed = (opts.policy?.accept ?? []).map(normalizeExtension).join(", ");
    return {
      ok: false,
      reason: "extension-not-allowed",
      message: `that file type is not accepted (expected ${allowed})`,
    };
  }

  return { ok: true, path: resolved };
}

export interface MoveFileInputFailure {
  input: string;
  reason: MoveFileInputRejection;
  message: string;
}

/**
 * Validate every `file` input a move declares, returning the normalized values
 * and any rejections. Inputs the move did not declare are untouched — this owns
 * file inputs only.
 */
export function validateMoveFileInputs(
  declaredInputs: MoveInput[] | undefined,
  values: Record<string, unknown>,
  opts: { projectRoot: string; statFile?: (path: string) => FileStat },
): { values: Record<string, unknown>; failures: MoveFileInputFailure[] } {
  const next = { ...values };
  const failures: MoveFileInputFailure[] = [];

  for (const input of declaredInputs ?? []) {
    if (input.type !== "file") continue;
    if (!(input.name in next) && !input.required) continue;

    const check = validateMoveFileInput(next[input.name], {
      projectRoot: opts.projectRoot,
      policy: input.file,
      required: input.required,
      statFile: opts.statFile,
    });

    if (check.ok) {
      if (check.path) next[input.name] = check.path;
      else delete next[input.name];
    } else {
      failures.push({ input: input.name, reason: check.reason, message: check.message });
    }
  }

  return { values: next, failures };
}

/** One line naming what was rejected, safe to return to the caller. */
export function formatFileInputFailures(failures: MoveFileInputFailure[]): string {
  return failures.map((failure) => `${failure.input}: ${failure.message}`).join("; ");
}
