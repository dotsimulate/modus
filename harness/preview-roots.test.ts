import { expect, test } from "bun:test";
import { configuredRootsForCwd } from "./preview-roots";

test("an explicit cwd inherits its configured user-project root", () => {
  const project = "D:\\projects\\modus-demo";
  const cwd = "D:\\projects\\modus-demo\\packages\\app";
  expect(configuredRootsForCwd(cwd, [], [project])).toEqual([project, cwd]);
});

test("an arbitrary cwd does not become a preview root", () => {
  expect(configuredRootsForCwd("D:\\secrets", [], ["D:\\projects\\modus-demo"])).toEqual([]);
});
