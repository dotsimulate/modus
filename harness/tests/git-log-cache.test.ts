import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clearGitLogCache, gitLog, gitLogWithFiles } from "../git";
import { removeTreeAfterExit } from "./fixtures/remove-tree";

let repo = "";

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function commit(name: string) {
  writeFileSync(join(repo, name), `${name}\n`);
  git("add", name);
  git("commit", "-q", "-m", `add ${name}`);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "modus-git-log-cache-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Modus Test");
  git("config", "user.email", "modus-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  commit("one.txt");
});

afterAll(async () => { await removeTreeAfterExit(repo); });
beforeEach(() => clearGitLogCache());

describe("git log cache", () => {
  test("concurrent identical requests agree and a new commit is seen immediately", async () => {
    const [a, b, c] = await Promise.all([gitLog(repo, 200), gitLog(repo, 200), gitLog(repo, 200)]);
    expect(a.map((entry) => entry.message.trim())).toEqual(["add one.txt"]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);

    // The cache is keyed on HEAD, so moving HEAD invalidates it with no TTL.
    commit("two.txt");
    const after = await gitLog(repo, 200);
    expect(after.map((entry) => entry.message.trim())).toEqual(["add two.txt", "add one.txt"]);
    expect(after[0]!.additions).toBe(1);
  });

  test("different arguments are cached separately", async () => {
    const one = await gitLog(repo, 1);
    const all = await gitLog(repo, 200);
    expect(one).toHaveLength(1);
    expect(all.length).toBeGreaterThan(1);
    const withFiles = await gitLogWithFiles(repo, { limit: 1 });
    expect(withFiles[0]!.files).toContain("two.txt");
  });

  test("a directory that is not a repository still answers empty", async () => {
    const plain = mkdtempSync(join(tmpdir(), "modus-git-log-plain-"));
    try {
      expect(await gitLog(plain, 10)).toEqual([]);
    } finally {
      await removeTreeAfterExit(plain);
    }
  });
});
