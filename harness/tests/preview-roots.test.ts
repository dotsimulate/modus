import { expect, test } from "bun:test";
import { configuredRootsForCwd } from "../preview-roots";

// configuredRootsForCwd resolves paths and does OS-specific within-root matching,
// so exercise it with absolute paths that are valid on the host platform.
const isWin = process.platform === "win32";
const project = isWin ? "D:\\projects\\modus-demo" : "/projects/modus-demo";
const nestedCwd = isWin
  ? "D:\\projects\\modus-demo\\packages\\app"
  : "/projects/modus-demo/packages/app";
const outsideCwd = isWin ? "D:\\secrets" : "/secrets";

test("an explicit cwd inherits its configured user-project root", () => {
  expect(configuredRootsForCwd(nestedCwd, [], [project])).toEqual([project, nestedCwd]);
});

test("an arbitrary cwd does not become a preview root", () => {
  expect(configuredRootsForCwd(outsideCwd, [], [project])).toEqual([]);
});
