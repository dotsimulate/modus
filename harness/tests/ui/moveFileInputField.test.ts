/**
 * `harness/ui` has no DOM test environment, so the file input's logic is tested
 * where it is pure: the picker's accept filter (shared with the backend so the
 * listing cannot show a file the server will reject) and `parentDir`, which
 * decides where the picker reopens.
 */
import { describe, expect, test } from "bun:test";
import { acceptsFileName } from "../../move-file-accept";
import { folderLabel, parentDir } from "../../ui/src/folderPath";

describe("picker accept filter", () => {
  // The same function the server re-enforces at activation. If these two ever
  // disagreed, the picker would offer a file that activation then rejects.
  test("filters a listing to the declared extensions", () => {
    const listing = ["logo.png", "logo.PNG", "notes.txt", "Makefile", "archive.tar.gz"];
    expect(listing.filter((name) => acceptsFileName(name, [".png"]))).toEqual(["logo.png", "logo.PNG"]);
    expect(listing.filter((name) => acceptsFileName(name, [".gz"]))).toEqual(["archive.tar.gz"]);
    expect(listing.filter((name) => acceptsFileName(name, undefined))).toEqual(listing);
  });
});

describe("parentDir", () => {
  test("returns the containing directory for both separator styles", () => {
    expect(parentDir("/projects/demo/assets/logo.png")).toBe("/projects/demo/assets");
    expect(parentDir("D:\\projects\\demo\\logo.png")).toBe("D:\\projects\\demo");
  });

  test("a trailing separator does not produce an empty last segment", () => {
    expect(parentDir("/projects/demo/")).toBe("/projects");
  });

  test("a root child keeps the root separator rather than returning empty", () => {
    expect(parentDir("/logo.png")).toBe("/");
  });

  test("a bare name has no known parent", () => {
    // Returning "." or "/" here would send the picker somewhere arbitrary.
    expect(parentDir("logo.png")).toBe("");
  });

  test("it pairs with folderLabel to split a path", () => {
    const path = "D:\\projects\\demo\\logo.png";
    expect(parentDir(path)).toBe("D:\\projects\\demo");
    expect(folderLabel(path)).toBe("logo.png");
  });
});
