/**
 * Drift guard for the third-party license notices.
 *
 * The committed `THIRD-PARTY-NOTICES.md` and `sbom.cdx.json` must describe the
 * dependency graph that is actually installed. Add an npm dependency without
 * regenerating and this fails — which is the point: a notices file that can
 * fall behind silently is worse than none, because it claims completeness it no
 * longer has.
 *
 * Only the JavaScript half is checked here. Crate license text lives in the
 * cargo registry, which exists in CI's Rust job and not in the Bun job that
 * runs this suite, so the Rust half is verified there by
 * `bun run notices:check rust`. That is a division by available inputs, not a
 * skip: both halves are checked on every change that can move them.
 *
 * Regenerate with `bun run notices:generate` from `harness/`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import type { Component } from "../scripts/generate-notices";
import {
  DEFAULT_TARGET,
  INSTALLER_LICENSE_PATH,
  NOTICES_PATH,
  NOT_REDISTRIBUTED,
  SBOM_PATH,
  VENDORED_BUN_LICENSE,
  bunLicenseStamp,
  collectNpmComponents,
  cargoTargetApplies,
  electLicenses,
  extractSection,
  normalizeEol,
  partitionRedistributed,
  pinnedBunVersion,
  renderInstallerLicense,
  renderNotices,
  renderSbom,
  sbomComponentsFor,
} from "../scripts/generate-notices";

/**
 * Walking the installed graph is the expensive part of this file: several hundred
 * packages, each read from disk. Four tests want the same snapshot, and taking it
 * four times pushed a single test past Bun's default 5s timeout on a loaded
 * machine — a flake that reddens CI without anything having drifted. Take it once.
 *
 * Nothing below mutates the result: `partitionRedistributed` and `renderSbom`
 * both build fresh arrays, and the remaining reader only iterates.
 */
let installedNpm: Component[] | null = null;
function installedNpmComponents(): Component[] {
  installedNpm ??= collectNpmComponents(DEFAULT_TARGET);
  return installedNpm;
}

/** Generous: the walk is filesystem-bound and CI runners are slower than this one. */
const GRAPH_WALK_TIMEOUT_MS = 60_000;

describe("third-party notices", () => {
  test("the notices and SBOM are committed", () => {
    expect(existsSync(NOTICES_PATH)).toBe(true);
    expect(existsSync(SBOM_PATH)).toBe(true);
    expect(existsSync(INSTALLER_LICENSE_PATH)).toBe(true);
  });

  test("the JavaScript section matches the installed dependency graph", () => {
    const npm = installedNpmComponents();
    const rendered = renderNotices({ target: DEFAULT_TARGET, npm, cargo: [], binary: [] });
    const committed = normalizeEol(readFileSync(NOTICES_PATH, "utf-8"));
    expect(extractSection(rendered, "javascript")).toBe(extractSection(committed, "javascript"));
  }, GRAPH_WALK_TIMEOUT_MS);

  test("the SBOM's npm components match the installed dependency graph", () => {
    const components = installedNpmComponents();
    const expected = JSON.parse(renderSbom({ target: DEFAULT_TARGET, components })).components;
    expect(sbomComponentsFor(readFileSync(SBOM_PATH, "utf-8"), "pkg:npm/")).toEqual(expected);
  }, GRAPH_WALK_TIMEOUT_MS);

  test("the installer license page carries the third-party pointer", () => {
    const committed = normalizeEol(readFileSync(INSTALLER_LICENSE_PATH, "utf-8"));
    expect(committed).toBe(normalizeEol(renderInstallerLicense()));
    expect(committed).toContain("THIRD-PARTY COMPONENTS");
    expect(committed).toContain("Functional Source License");
  });

  test("the vendored Bun notice is stamped for the pinned runtime", () => {
    const version = pinnedBunVersion();
    expect(readFileSync(VENDORED_BUN_LICENSE, "utf-8")).toContain(bunLicenseStamp(version));
  });

  test("every not-redistributed entry still applies to an installed package", () => {
    // A stale exclusion is the dangerous direction: it would quietly drop a
    // component that started shipping. Over-inclusion is safe; silent omission
    // is the failure this whole file exists to prevent.
    const { excluded } = partitionRedistributed(installedNpmComponents());
    expect(excluded.map((component) => `${component.name}@${component.version}`).sort())
      .toEqual(Object.keys(NOT_REDISTRIBUTED).sort());
  });

  test("the proprietary Claude Code binary is not listed as redistributed", () => {
    // Claiming to redistribute a 322 MB proprietary binary we never ship is a
    // materially false statement, not a conservative over-inclusion.
    const sbom = readFileSync(SBOM_PATH, "utf-8");
    expect(sbom).not.toContain("claude-agent-sdk-win32-x64");
    // The SDK's own JavaScript *is* inlined into server.js, so it must stay.
    expect(sbom).toContain("pkg:npm/%40anthropic-ai/claude-agent-sdk@");
  });

  test("every JavaScript component reproduces a license text", () => {
    for (const component of installedNpmComponents()) {
      expect(component.texts.length).toBeGreaterThan(0);
      for (const text of component.texts) {
        expect(text.body.trim()).not.toBe("");
      }
    }
  });
});

describe("cargo target filtering", () => {
  // Facts are fixed to the packaged target (x86_64-pc-windows-msvc).
  test("an unconditional edge always applies", () => {
    expect(cargoTargetApplies(null)).toBe(true);
    expect(cargoTargetApplies(undefined)).toBe(true);
  });

  test("keeps Windows edges and drops the rest", () => {
    expect(cargoTargetApplies('cfg(target_os = "windows")')).toBe(true);
    expect(cargoTargetApplies("cfg(windows)")).toBe(true);
    expect(cargoTargetApplies('cfg(target_os = "macos")')).toBe(false);
    expect(cargoTargetApplies("cfg(unix)")).toBe(false);
  });

  test("evaluates all/any/not", () => {
    expect(cargoTargetApplies('cfg(any(target_os = "macos", target_os = "ios"))')).toBe(false);
    expect(cargoTargetApplies('cfg(any(target_os = "macos", target_os = "windows"))')).toBe(true);
    expect(cargoTargetApplies('cfg(all(target_os = "windows", target_arch = "x86_64"))')).toBe(true);
    expect(cargoTargetApplies('cfg(all(target_os = "windows", target_arch = "aarch64"))')).toBe(false);
    expect(cargoTargetApplies('cfg(not(target_os = "windows"))')).toBe(false);
    expect(cargoTargetApplies("cfg(not(windows))")).toBe(false);
  });

  test("matches an explicit triple exactly", () => {
    expect(cargoTargetApplies("x86_64-pc-windows-msvc")).toBe(true);
    expect(cargoTargetApplies("x86_64-apple-darwin")).toBe(false);
  });

  test("an unknown predicate over-includes rather than dropping a component", () => {
    expect(cargoTargetApplies('cfg(target_has_atomic = "128")')).toBe(true);
    expect(cargoTargetApplies("cfg(feature_we_do_not_model)")).toBe(true);
  });
});

describe("SPDX election", () => {
  test("picks the most permissive branch of a choice", () => {
    expect(electLicenses("Apache-2.0 OR MIT")).toEqual(["MIT"]);
    expect(electLicenses("Zlib OR Apache-2.0 OR MIT")).toEqual(["MIT"]);
    expect(electLicenses("Unlicense OR MIT")).toEqual(["MIT"]);
  });

  test("accepts cargo's pre-SPDX slash form", () => {
    expect(electLicenses("MIT/Apache-2.0")).toEqual(["MIT"]);
    expect(electLicenses("Apache-2.0 / MIT")).toEqual(["MIT"]);
  });

  test("keeps every operand of a conjunction", () => {
    expect(electLicenses("(MIT OR Apache-2.0) AND Unicode-3.0")).toEqual(["MIT", "Unicode-3.0"]);
    expect(electLicenses("Apache-2.0 AND ISC")).toEqual(["Apache-2.0", "ISC"]);
  });

  test("treats an exception as part of the license it modifies", () => {
    expect(electLicenses("Apache-2.0 WITH LLVM-exception")).toEqual(["Apache-2.0 WITH LLVM-exception"]);
    expect(electLicenses("Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT")).toEqual(["MIT"]);
  });

  test("rejects a field that is not an SPDX expression rather than guessing", () => {
    // These reach the generator as npm `license` values and must be answered in
    // overrides.json, not silently reinterpreted.
    expect(() => electLicenses("Public Domain")).toThrow(/Trailing tokens/);
    expect(() => electLicenses("(MIT OR Apache-2.0")).toThrow(/Unbalanced parentheses/);
  });
});
