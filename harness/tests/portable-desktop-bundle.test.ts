import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { makeBundlePortable } from "../../desktop/portable-bundle";

describe("portable desktop JavaScript bundles", () => {
  test("rewrites one generated module directory and rejects host paths", () => {
    const checkout = resolve("D:\\builder\\modus");
    const dependency = resolve(checkout, "harness", "node_modules", "native-package");
    const source = `var __dirname = ${JSON.stringify(dependency)};\nload(__dirname);`;

    expect(makeBundlePortable(source, [dependency], [checkout]))
      .toBe("var __dirname = import.meta.dir;\nload(__dirname);");
  });

  test("fails closed when Bun's generated declaration changes", () => {
    expect(() => makeBundlePortable("load(__dirname);", [resolve("native-package")], []))
      .toThrow("Expected one bundled __dirname declaration");
  });

  test("fails closed when an unrelated private path survives", () => {
    const checkout = resolve("D:\\builder\\modus");
    expect(() => makeBundlePortable(`const path = ${JSON.stringify(checkout)};`, [], [checkout]))
      .toThrow("contains private host path");
  });
});
