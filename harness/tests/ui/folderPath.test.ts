import { describe, expect, it } from "bun:test";
import { folderLabel, joinBrowsePath, validateFolderName } from "../../ui/src/folderPath";

describe("validateFolderName", () => {
  it("accepts an ordinary name, including one with spaces", () => {
    expect(validateFolderName("Cooking Project")).toEqual({ ok: true, name: "Cooking Project" });
  });

  it("trims surrounding whitespace rather than rejecting it", () => {
    expect(validateFolderName("  notes  ")).toEqual({ ok: true, name: "notes" });
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(validateFolderName("")).toMatchObject({ ok: false });
    expect(validateFolderName("   ")).toMatchObject({ ok: false });
  });

  it("rejects separators so the picker can only create one folder in place", () => {
    // Without this a name like "../escape" would create a directory outside the
    // folder the user is looking at, which the dir-create route would happily do.
    expect(validateFolderName("a/b")).toMatchObject({ ok: false });
    expect(validateFolderName("a\\b")).toMatchObject({ ok: false });
    expect(validateFolderName("../escape")).toMatchObject({ ok: false });
  });

  it("rejects bare dot names", () => {
    expect(validateFolderName(".")).toMatchObject({ ok: false });
    expect(validateFolderName("..")).toMatchObject({ ok: false });
  });

  it("allows a leading dot, which is a legitimate hidden folder", () => {
    expect(validateFolderName(".modus")).toEqual({ ok: true, name: ".modus" });
  });

  it("rejects characters Windows cannot store", () => {
    for (const bad of ["a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b"]) {
      expect(validateFolderName(bad)).toMatchObject({ ok: false, error: "invalid character" });
    }
  });

  it("rejects control characters", () => {
    // Built by code point: a literal control byte in this file would make it
    // binary to git and grep.
    const withNul = `bad${String.fromCharCode(0)}name`;
    expect(validateFolderName(withNul)).toMatchObject({ ok: false, error: "invalid character" });
  });

  it("rejects Windows reserved device names, with or without an extension", () => {
    expect(validateFolderName("con")).toMatchObject({ ok: false, error: "reserved name" });
    expect(validateFolderName("COM1")).toMatchObject({ ok: false, error: "reserved name" });
    expect(validateFolderName("nul.txt")).toMatchObject({ ok: false, error: "reserved name" });
    expect(validateFolderName("console")).toMatchObject({ ok: true });
  });

  it("rejects a trailing space or period, which Windows would silently strip", () => {
    expect(validateFolderName("name.")).toMatchObject({ ok: false });
    // A trailing space survives the trim only when it is not at the very end,
    // so this asserts the period case carries the same rule.
    expect(validateFolderName("a b.")).toMatchObject({ ok: false });
  });

  it("reports a collision against the listing already on screen", () => {
    expect(validateFolderName("notes", ["docs", "notes"]))
      .toEqual({ ok: false, error: "already exists" });
  });

  it("treats a collision case-insensitively, matching Windows and macOS", () => {
    expect(validateFolderName("Notes", ["notes"]))
      .toEqual({ ok: false, error: "already exists" });
  });
});

describe("joinBrowsePath", () => {
  it("joins a posix path", () => {
    expect(joinBrowsePath("/home/user", "new")).toBe("/home/user/new");
  });

  it("joins a windows path without converting the existing separators", () => {
    expect(joinBrowsePath("C:\\Users\\me\\Desktop", "new")).toBe("C:\\Users\\me\\Desktop/new");
  });

  it("does not double the separator at a root", () => {
    expect(joinBrowsePath("/", "new")).toBe("/new");
    expect(joinBrowsePath("D:\\", "new")).toBe("D:/new");
  });
});

describe("folderLabel", () => {
  it("returns the last segment of a windows path", () => {
    // The picker used to split on "/" only, so this returned the whole string
    // and the select button read as a full path.
    expect(folderLabel("C:\\Users\\me\\Desktop")).toBe("Desktop");
  });

  it("returns the last segment of a posix path", () => {
    expect(folderLabel("/home/user/projects")).toBe("projects");
  });

  it("ignores a trailing separator", () => {
    expect(folderLabel("/home/user/projects/")).toBe("projects");
  });
});
