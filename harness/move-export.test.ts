import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { collectPortableMoveEntries, isPortableMoveFileName } from "./move-export";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "modus-move-export-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeProjectFile(projectDir: string, relPath: string, content = ""): void {
  const absPath = join(projectDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
}

describe("move export", () => {
  test("exports only direct move files and skips nested content", () => {
    const projectDir = makeTempProject();

    writeProjectFile(projectDir, ".modus/moves/demo/move.json", JSON.stringify({ name: "demo" }, null, 2));
    writeProjectFile(projectDir, ".modus/moves/demo/context.ts", "export async function gather() { return 'hi'; }\n");
    writeProjectFile(projectDir, ".modus/moves/demo/widget.tsx", "export default function Widget() { return null; }\n");
    writeProjectFile(projectDir, ".modus/moves/demo/docs/spec.md", "# spec\n");
    writeProjectFile(projectDir, ".modus/moves/demo/prompts/base.md", "prompt\n");
    writeProjectFile(projectDir, ".modus/moves/demo/assets/icon.svg", "<svg />\n");
    writeProjectFile(projectDir, ".modus/moves/demo/assets/theme.css", "body {}\n");
    writeProjectFile(projectDir, ".modus/moves/demo/state/session.json", "{\"private\":true}\n");
    writeProjectFile(projectDir, ".modus/moves/demo/history/run.json", "{\"turns\":1}\n");
    writeProjectFile(projectDir, ".modus/moves/demo/.history/run.md", "history\n");
    writeProjectFile(projectDir, ".modus/moves/demo/notes/private.md", "personal\n");
    writeProjectFile(projectDir, ".modus/moves/demo/memories/profile.md", "private\n");
    writeProjectFile(projectDir, ".modus/moves/demo/rooms/chat.md", "room\n");
    writeProjectFile(projectDir, ".modus/moves/demo/output/render.wav", "audio\n");
    writeProjectFile(projectDir, ".modus/moves/demo/outputs/output.md", "output\n");
    writeProjectFile(projectDir, ".modus/moves/demo/gallery/image.png", "png\n");
    writeProjectFile(projectDir, ".modus/moves/demo/downloads/song.mp3", "mp3\n");
    writeProjectFile(projectDir, ".modus/moves/demo/clip-cache/cache.wav", "wav\n");
    writeProjectFile(projectDir, ".modus/moves/demo/tmp/scratch.json", "{}\n");
    writeProjectFile(projectDir, ".modus/moves/demo/timing/episode.json", "{}\n");
    writeProjectFile(projectDir, ".modus/moves/demo/cache.db", "db\n");
    writeProjectFile(projectDir, ".modus/moves/demo/export.zip", "zip\n");
    writeProjectFile(projectDir, ".modus/moves/demo/reference/voice-note.wav", "wav\n");
    writeProjectFile(projectDir, ".modus/moves/portable/move.json", JSON.stringify({ name: "portable" }, null, 2));
    writeProjectFile(projectDir, ".modus/moves/portable/README.md", "portable\n");
    writeProjectFile(projectDir, ".modus/moves/not-a-move/file.txt", "skip\n");

    const collected = collectPortableMoveEntries(projectDir);
    const relPaths = collected.entries
      .map((entry) => `${entry.moveName}/${entry.fileName}`)
      .sort();

    expect(collected.moveNames).toEqual(["demo", "portable"]);
    expect(relPaths).toEqual([
      "demo/context.ts",
      "demo/move.json",
      "demo/widget.tsx",
      "portable/README.md",
      "portable/move.json",
    ]);
  });

  test("portable filename matcher allows direct source files only", () => {
    expect(isPortableMoveFileName("move.json")).toBe(true);
    expect(isPortableMoveFileName("context.ts")).toBe(true);
    expect(isPortableMoveFileName("widget.tsx")).toBe(true);
    expect(isPortableMoveFileName("README.md")).toBe(true);
    expect(isPortableMoveFileName("docs/spec.md")).toBe(false);
    expect(isPortableMoveFileName("prompts/base.md")).toBe(false);
    expect(isPortableMoveFileName("state/instance.json")).toBe(false);
    expect(isPortableMoveFileName("reference/voice-note.wav")).toBe(false);
    expect(isPortableMoveFileName("cache.sqlite")).toBe(false);
    expect(isPortableMoveFileName("export.zip")).toBe(false);
  });
});
