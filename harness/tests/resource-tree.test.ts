/**
 * A truncated resource tree is the quietest install failure there is: the backend
 * boots normally and simply reports every built-in as absent, so the complaint
 * lands on the user's project ("move was not found in this project") rather than
 * on the install. These tests pin the partial-delete shape that produced it —
 * a recursive delete stopped mid-directory, leaving some entries and removing
 * others — and pin that a healthy source checkout stays silent.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  REQUIRED_RESOURCE_DIRS,
  checkResourceTree,
  formatResourceTreeReport,
} from "../resource-tree";

const HARNESS_DIR = resolve(import.meta.dir, "..");

/** Build a resource tree containing every required directory, each non-empty. */
function makeCompleteTree(): string {
  const root = mkdtempSync(join(tmpdir(), "modus-resource-tree-"));
  for (const relative of REQUIRED_RESOURCE_DIRS) {
    const dir = join(root, relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "placeholder"), "");
  }
  return root;
}

describe("checkResourceTree", () => {
  test("a complete tree reports ok and renders no warning", () => {
    const root = makeCompleteTree();
    try {
      const report = checkResourceTree(root);
      expect(report.ok).toBe(true);
      expect(report.missing).toEqual([]);
      expect(report.empty).toEqual([]);
      expect(formatResourceTreeReport(report)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real source checkout is intact", () => {
    // Guards against the required list drifting away from what the repository
    // actually ships, which would make this check cry wolf on every dev boot.
    expect(checkResourceTree(HARNESS_DIR).ok).toBe(true);
  });

  test("a delete that stopped partway through is reported as missing", () => {
    const root = makeCompleteTree();
    try {
      // The observed 2026-08-22 failure: everything sorted before the locked
      // native addon was gone, everything after it survived.
      rmSync(join(root, "moves"), { recursive: true, force: true });
      rmSync(join(root, "pages"), { recursive: true, force: true });
      rmSync(join(root, "actions"), { recursive: true, force: true });

      const report = checkResourceTree(root);
      expect(report.ok).toBe(false);
      expect(report.missing).toEqual(["actions", "moves", "pages"]);
      expect(report.empty).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory that exists but holds nothing counts as empty, not missing", () => {
    const root = makeCompleteTree();
    try {
      rmSync(join(root, "moves", "placeholder"));

      const report = checkResourceTree(root);
      expect(report.ok).toBe(false);
      expect(report.missing).toEqual([]);
      expect(report.empty).toEqual(["moves"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absent tree reports every required directory", () => {
    const report = checkResourceTree(join(tmpdir(), "modus-resource-tree-does-not-exist"));
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([...REQUIRED_RESOURCE_DIRS]);
  });
});

describe("formatResourceTreeReport", () => {
  test("names the directory, the gaps, and the symptom it explains", () => {
    const root = makeCompleteTree();
    try {
      rmSync(join(root, "moves"), { recursive: true, force: true });
      const message = formatResourceTreeReport(checkResourceTree(root));

      expect(message).toContain(root);
      expect(message).toContain("moves");
      // The whole point of the line: connect it to the error the operator will
      // otherwise chase inside their own project.
      expect(message).toContain("was not found in this project");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
