import { describe, expect, test } from "bun:test";
import { determineCommitAttribution } from "../commit-attribution";

describe("determineCommitAttribution", () => {
  test("matches a recent commit when touched files overlap", () => {
    const result = determineCommitAttribution({
      cwd: "/tmp/worktree",
      touchedFiles: [
        "/tmp/worktree/harness/ui/src/components/ChatView.tsx",
        "/tmp/worktree/harness/index.ts",
      ],
      commits: [
        {
          hash: "abc1234",
          date: "2026-03-13T22:00:00.000Z",
          author: "dot",
          message: "Add backend commit attribution",
          filesChanged: 2,
          additions: 10,
          deletions: 3,
          files: ["harness/index.ts", "README.md"],
        },
      ],
    });

    expect(result).toEqual({
      matched: true,
      commit: {
        hash: "abc1234",
        date: "2026-03-13T22:00:00.000Z",
        author: "dot",
        message: "Add backend commit attribution",
        filesChanged: 2,
        additions: 10,
        deletions: 3,
      },
      matchedFiles: ["harness/index.ts"],
      source: "session",
    });
  });

  test("does not attribute a nearby commit when files do not overlap", () => {
    const result = determineCommitAttribution({
      cwd: "/tmp/worktree",
      touchedFiles: ["/tmp/worktree/harness/ui/src/components/ChatView.tsx"],
      commits: [
        {
          hash: "def5678",
          date: "2026-03-13T22:05:00.000Z",
          author: "dot",
          message: "Touch unrelated file",
          filesChanged: 1,
          additions: 2,
          deletions: 1,
          files: ["harness/index.ts"],
        },
      ],
    });

    expect(result).toEqual({
      matched: false,
      reason: "no-file-overlap",
    });
  });
});
