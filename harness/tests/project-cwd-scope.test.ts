import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildProjectCwdScope } from "../project-cwd-scope";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function matchingPaths(root: string, paths: string[]): string[] {
  const db = new Database(":memory:");
  databases.push(db);
  db.run("CREATE TABLE sessions (cwd TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO sessions (cwd) VALUES (?)");
  for (const path of paths) insert.run(path);
  const scope = buildProjectCwdScope("cwd", [root]);
  return (db.prepare(`SELECT cwd FROM sessions WHERE ${scope.sql} ORDER BY cwd`)
    .all(...scope.params) as Array<{ cwd: string }>).map((row) => row.cwd);
}

describe("project CWD scope", () => {
  test("matches the root and descendants without absorbing a sibling prefix", () => {
    expect(matchingPaths("D:\\Projects\\app", [
      "D:\\Projects\\app",
      "D:\\Projects\\app\\plugin",
      "D:\\Projects\\app-extra",
    ])).toEqual([
      "D:\\Projects\\app",
      "D:\\Projects\\app\\plugin",
    ]);
  });

  test("treats slash style and ASCII path case equivalently", () => {
    expect(matchingPaths("D:/Projects/App/", [
      "d:\\projects\\app",
      "D:/PROJECTS/APP/project",
      "D:/Projects/app-other",
    ])).toEqual([
      "D:/PROJECTS/APP/project",
      "d:\\projects\\app",
    ]);
  });

  test("escapes LIKE wildcard characters in project names", () => {
    expect(matchingPaths("/work/modus_100%", [
      "/work/modus_100%",
      "/work/modus_100%/child",
      "/work/modusX100-percent/child",
    ])).toEqual([
      "/work/modus_100%",
      "/work/modus_100%/child",
    ]);
  });
});
