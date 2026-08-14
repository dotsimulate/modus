/**
 * A `file` move input resolves to an absolute host path that move code opens.
 * The picker constrains what a user can choose, but every activation entry point
 * — the SDK, a page embed, a client extension, `POST /api/moves/activate` —
 * accepts `inputs` straight from a caller, so the policy is enforced where the
 * value is consumed. These tests are that boundary.
 *
 * The type-identity check at the bottom is the SDK/harness drift guard: the two
 * `MoveInput` declarations are separate on purpose (the SDK must not pull the
 * database in), which is exactly how `ExtensionSettingSchema` silently drifted.
 */
import { describe, expect, test } from "bun:test";
import { resolve, sep } from "path";
import {
  extensionAllowed,
  normalizeExtension,
  acceptsFileName,
} from "../move-file-accept";
import {
  formatFileInputFailures,
  validateMoveFileInput,
  validateMoveFileInputs,
  type FileStat,
} from "../move-file-input";
import type { MoveInput } from "../move-types";
import type { MoveInput as SdkMoveInput, MoveInputFilePolicy as SdkFilePolicy } from "../sdk/types";
import type { MoveInputFilePolicy } from "../move-types";

const PROJECT = resolve("/projects/demo");
const inside = (...parts: string[]) => resolve(PROJECT, ...parts);

/** A filesystem where every listed path is a readable file. */
function files(...paths: string[]): (path: string) => FileStat {
  const set = new Set(paths.map((p) => resolve(p)));
  return (path) => set.has(resolve(path))
    ? { exists: true, isFile: true }
    : { exists: false, isFile: false };
}

describe("extension matching", () => {
  test("a leading dot and case are both optional", () => {
    expect(normalizeExtension("PNG")).toBe(".png");
    expect(normalizeExtension(".PNG")).toBe(".png");
    expect(normalizeExtension("  .Png  ")).toBe(".png");
    expect(normalizeExtension("")).toBe("");
  });

  test("an empty or absent list accepts anything", () => {
    expect(extensionAllowed("/a/b.exe")).toBe(true);
    expect(extensionAllowed("/a/b.exe", [])).toBe(true);
  });

  test("matching is case-insensitive on both sides", () => {
    expect(acceptsFileName("Photo.PNG", [".png"])).toBe(true);
    expect(acceptsFileName("photo.png", ["PNG"])).toBe(true);
    expect(acceptsFileName("photo.gif", [".png", ".jpg"])).toBe(false);
  });

  test("a file with no extension is rejected by a non-empty list", () => {
    expect(acceptsFileName("Makefile", [".png"])).toBe(false);
  });
});

describe("single file input validation", () => {
  test("a file inside the project is accepted and returned resolved", () => {
    const check = validateMoveFileInput(inside("assets/logo.png"), {
      projectRoot: PROJECT,
      statFile: files(inside("assets/logo.png")),
    });
    expect(check).toEqual({ ok: true, path: inside("assets/logo.png") });
  });

  test("a file outside the project is rejected by default", () => {
    const outside = resolve("/etc/passwd");
    const check = validateMoveFileInput(outside, {
      projectRoot: PROJECT,
      statFile: files(outside),
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("outside-project");
  });

  test("traversal out of the project is rejected after resolution", () => {
    // The string looks project-relative; resolving it does not stay inside.
    const check = validateMoveFileInput(`${PROJECT}${sep}..${sep}other${sep}secret.txt`, {
      projectRoot: PROJECT,
      statFile: files(resolve(PROJECT, "..", "other", "secret.txt")),
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("outside-project");
  });

  test("a symlink inside the project pointing outside it is rejected", () => {
    // Containment is tested against the real path, so a link is not an escape.
    const link = inside("assets/innocent.txt");
    const target = resolve("/secrets/id_rsa");
    const check = validateMoveFileInput(link, {
      projectRoot: PROJECT,
      statFile: () => ({ exists: true, isFile: true, realPath: target }),
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("outside-project");
  });

  test("a move may opt out of project containment", () => {
    const outside = resolve("/tmp/scratch.txt");
    const check = validateMoveFileInput(outside, {
      projectRoot: PROJECT,
      policy: { allowOutsideProject: true },
      statFile: files(outside),
    });
    expect(check.ok).toBe(true);
  });

  test("an extension outside the accept list is rejected and the message names the list", () => {
    const path = inside("notes.txt");
    const check = validateMoveFileInput(path, {
      projectRoot: PROJECT,
      policy: { accept: [".png", "jpg"] },
      statFile: files(path),
    });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("extension-not-allowed");
      expect(check.message).toContain(".png");
      expect(check.message).toContain(".jpg");
    }
  });

  test("a missing path is rejected", () => {
    const check = validateMoveFileInput(inside("gone.png"), {
      projectRoot: PROJECT,
      statFile: files(),
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("missing");
  });

  test("a directory is rejected as not a file", () => {
    const check = validateMoveFileInput(inside("assets"), {
      projectRoot: PROJECT,
      statFile: () => ({ exists: true, isFile: false }),
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("not-a-file");
  });

  test("an empty optional value is accepted as no selection", () => {
    // Cancelling the picker must not fail the form.
    expect(validateMoveFileInput("", { projectRoot: PROJECT })).toEqual({ ok: true, path: "" });
    expect(validateMoveFileInput("   ", { projectRoot: PROJECT })).toEqual({ ok: true, path: "" });
    expect(validateMoveFileInput(undefined, { projectRoot: PROJECT })).toEqual({ ok: true, path: "" });
  });

  test("an empty required value is rejected", () => {
    const check = validateMoveFileInput("", { projectRoot: PROJECT, required: true });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("empty");
  });

  test("a non-string value is treated as no selection", () => {
    expect(validateMoveFileInput(42, { projectRoot: PROJECT })).toEqual({ ok: true, path: "" });
    expect(validateMoveFileInput({ path: "/etc/passwd" }, { projectRoot: PROJECT })).toEqual({ ok: true, path: "" });
  });
});

describe("validating a move's declared inputs", () => {
  const inputs: MoveInput[] = [
    { name: "topic", type: "text" },
    { name: "image", type: "file", file: { accept: [".png"] } },
  ];

  test("only file inputs are touched", () => {
    const { values, failures } = validateMoveFileInputs(
      inputs,
      { topic: "  keep me as typed  ", image: inside("a.png") },
      { projectRoot: PROJECT, statFile: files(inside("a.png")) },
    );
    expect(failures).toEqual([]);
    expect(values.topic).toBe("  keep me as typed  ");
    expect(values.image).toBe(inside("a.png"));
  });

  test("a rejected file is reported and named", () => {
    const { failures } = validateMoveFileInputs(
      inputs,
      { image: resolve("/etc/shadow") },
      { projectRoot: PROJECT, statFile: files(resolve("/etc/shadow")) },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]!.input).toBe("image");
    expect(failures[0]!.reason).toBe("outside-project");
    expect(formatFileInputFailures(failures)).toContain("image:");
  });

  test("an absent optional file input is left absent rather than set empty", () => {
    const { values, failures } = validateMoveFileInputs(inputs, { topic: "x" }, { projectRoot: PROJECT });
    expect(failures).toEqual([]);
    expect("image" in values).toBe(false);
  });

  test("an absent required file input is reported", () => {
    const required: MoveInput[] = [{ name: "image", type: "file", required: true }];
    const { failures } = validateMoveFileInputs(required, {}, { projectRoot: PROJECT });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBe("empty");
  });

  test("a move with no file inputs is passed through untouched", () => {
    const values = { topic: "x", other: 3 };
    const result = validateMoveFileInputs([{ name: "topic", type: "text" }], values, { projectRoot: PROJECT });
    expect(result.values).toEqual(values);
    expect(result.failures).toEqual([]);
  });
});

describe("the SDK and harness MoveInput declarations agree", () => {
  // Two declarations exist on purpose — the SDK must not import the database —
  // so nothing but a check like this stops them drifting. Caught only by tsc.
  test("the shapes are mutually assignable", () => {
    const fromHarness: MoveInput = { name: "f", type: "file", file: { accept: [".png"] } };
    const asSdk: SdkMoveInput = fromHarness;
    const backToHarness: MoveInput = asSdk;
    expect(backToHarness.type).toBe("file");

    const policy: MoveInputFilePolicy = { accept: [".png"], allowOutsideProject: false };
    const sdkPolicy: SdkFilePolicy = policy;
    const roundTrip: MoveInputFilePolicy = sdkPolicy;
    expect(roundTrip.allowOutsideProject).toBe(false);
  });
});
