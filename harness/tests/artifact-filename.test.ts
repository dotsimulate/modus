import { describe, expect, test } from "bun:test";
import { safeArtifactFilename } from "../action-runner";

/**
 * Artifact filenames become URLs: whatever lands in the run's artifact
 * directory is served by GET /api/sessions/:id/artifacts/:artifactId. Actions
 * are trusted local code, so this is not a sandbox — it is a guard for names
 * that arrive from somewhere less deliberate than the action author.
 */
describe("safeArtifactFilename", () => {
  test("keeps an ordinary filename intact", () => {
    expect(safeArtifactFilename("speak-back.wav")).toBe("speak-back.wav");
    expect(safeArtifactFilename("2026-07-29T05-46-39-565Z-3f6f.wav")).toBe("2026-07-29T05-46-39-565Z-3f6f.wav");
  });

  test("strips traversal segments instead of escaping the artifact directory", () => {
    expect(safeArtifactFilename("../../../etc/passwd")).toBe("passwd");
    expect(safeArtifactFilename("..\\..\\Windows\\System32\\config\\SAM")).toBe("SAM");
    expect(safeArtifactFilename("a/b/c/report.pdf")).toBe("report.pdf");
  });

  test("drops an absolute path down to its basename", () => {
    expect(safeArtifactFilename("/etc/shadow")).toBe("shadow");
    expect(safeArtifactFilename("C:\\Users\\someone\\.ssh\\id_rsa")).toBe("id_rsa");
  });

  test("rejects names that resolve to a directory rather than rewriting them", () => {
    // Silently turning ".." into a plausible-looking name would hide the fact
    // that the caller asked for something it should not have.
    expect(() => safeArtifactFilename("..")).toThrow(/invalid artifact filename/);
    expect(() => safeArtifactFilename(".")).toThrow(/invalid artifact filename/);
    expect(() => safeArtifactFilename("foo/")).toThrow(/invalid artifact filename/);
    expect(() => safeArtifactFilename("")).toThrow(/invalid artifact filename/);
    expect(() => safeArtifactFilename("   ")).toThrow(/invalid artifact filename/);
  });

  test("strips NUL bytes, which truncate paths in some syscalls", () => {
    expect(safeArtifactFilename("clip.wav\u0000.txt")).toBe("clip.wav.txt");
  });
});
