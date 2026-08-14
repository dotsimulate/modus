import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(resolveTestSourceDir(import.meta.dir, "..", "..", "ui"), "src", "components");
const read = (name: string) => readFileSync(join(SRC, name), "utf8");

// The file-history submenu shipped on the editor/tab/markdown menus but not on the file
// tree, so right-clicking a file that was never opened offered nothing. Typecheck cannot
// see a menu that is merely absent, hence a source scan.
describe("file-history menu surfaces", () => {
  for (const file of ["CodeWorkspacePanel.tsx", "FileBrowser.tsx"]) {
    test(`${file} builds its history item from the shared helper`, () => {
      const src = read(file);
      expect(src).toContain('from "./fileHistoryMenu"');
      expect(src).toContain("buildFileHistoryItem(");
    });
  }

  // Computing the item is not offering it: the first version of this guard passed against
  // a build where `historyItem` was assigned and then never spread into the returned array.
  test("the file tree's returned menu actually includes the history item", () => {
    const src = read("FileBrowser.tsx");
    const start = src.indexOf("const buildFileItems");
    expect(start).toBeGreaterThan(-1);
    const scope = src.slice(start, src.indexOf("const buildDirItems", start));
    expect(scope).toContain("buildFileHistoryItem(");

    const returned = scope.slice(scope.indexOf("return ["), scope.indexOf("];"));
    expect(returned).toContain("historyItem");
  });

  test("both file-tree instances can navigate to a session", () => {
    const src = read("CodeWorkspacePanel.tsx");
    const passes = src.match(/onSelectSession=\{onSelectSession\}/g) ?? [];
    const mounts = src.match(/<FileBrowser\b/g) ?? [];
    expect(mounts.length).toBeGreaterThan(0);
    expect(passes.length).toBe(mounts.length);
  });

  // Nothing typechecks a submenu's copy, and an empty result must not read as "never touched".
  test("the empty state does not claim the file was never edited", () => {
    const src = read("fileHistoryMenu.tsx");
    expect(src).toContain('emptyLabel: "no recorded edits"');
  });
});
