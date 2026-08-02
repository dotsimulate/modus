import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";

export const PORTABLE_MOVE_EXCLUDE_FILE_PATTERNS = [
  /^_registry\.json$/,
  /^moves-backup-/,
  /^moves-export-/,
  /\.db$/i,
  /\.sqlite$/i,
  /\.zip$/i,
] as const;

export const PORTABLE_MOVE_EXCLUDE_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".opus",
  ".aif",
  ".aiff",
  ".mp4",
  ".mov",
  ".webm",
  ".avi",
  ".mkv",
]);

export type PortableMoveEntry = {
  absPath: string;
  fileName: string;
  moveName: string;
};

export type ExportPortableMovesResult =
  | { ok: true; outputPath: string; moveNames: string[]; fileCount: number }
  | { ok: false; error: string };

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

export function isPortableMoveFileName(fileName: string): boolean {
  const normalized = toPosixPath(fileName).replace(/^\.?\//, "");
  if (!normalized || normalized.includes("/")) return false;
  if (PORTABLE_MOVE_EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  const lower = normalized.toLowerCase();
  for (const ext of PORTABLE_MOVE_EXCLUDE_EXTENSIONS) {
    if (lower.endsWith(ext)) return false;
  }
  return true;
}

function readMoveDescription(moveJsonPath: string): string | undefined {
  try {
    const raw = readFileSync(moveJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { description?: unknown };
    return typeof parsed.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function collectPortableMoveEntries(projectDir: string): {
  movesDir: string;
  moveNames: string[];
  entries: PortableMoveEntry[];
} {
  const resolvedProjectDir = resolve(projectDir);
  const movesDir = join(resolvedProjectDir, ".modus", "moves");
  if (!existsSync(movesDir)) {
    return { movesDir, moveNames: [], entries: [] };
  }

  const moveNames: string[] = [];
  const entries: PortableMoveEntry[] = [];

  for (const entry of readdirSync(movesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const moveDir = join(movesDir, entry.name);
    const moveJsonPath = join(moveDir, "move.json");
    if (!existsSync(moveJsonPath) || !statSync(moveJsonPath).isFile()) continue;
    moveNames.push(entry.name);
    for (const moveEntry of readdirSync(moveDir, { withFileTypes: true })) {
      if (!moveEntry.isFile()) continue;
      if (!isPortableMoveFileName(moveEntry.name)) continue;
      entries.push({
        absPath: join(moveDir, moveEntry.name),
        fileName: moveEntry.name,
        moveName: entry.name,
      });
    }
  }

  return { movesDir, moveNames: moveNames.sort(), entries };
}

function stagePortableMovesExport(stageRoot: string, projectDir: string): {
  moveNames: string[];
  fileCount: number;
} {
  const { moveNames, entries } = collectPortableMoveEntries(projectDir);
  const stagedMovesDir = join(stageRoot, ".modus", "moves");
  mkdirSync(stagedMovesDir, { recursive: true });

  for (const moveName of moveNames) {
    mkdirSync(join(stagedMovesDir, moveName), { recursive: true });
  }

  for (const entry of entries) {
    const destPath = join(stagedMovesDir, entry.moveName, entry.fileName);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(entry.absPath, destPath);
  }

  const manifest = {
    format: "modus-moves-export-v1",
    exportedAt: new Date().toISOString(),
    exportRule: "direct-files-only",
    moveNames,
    fileCount: entries.length,
    excludes: PORTABLE_MOVE_EXCLUDE_FILE_PATTERNS.map((pattern) => pattern.source),
    excludeExtensions: [...PORTABLE_MOVE_EXCLUDE_EXTENSIONS].sort(),
    importHint: "Unzip into a project root to merge into .modus/moves/",
  };
  writeFileSync(
    join(stageRoot, "moves-export.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );

  return { moveNames, fileCount: entries.length };
}

function createZipFromDirectory(sourceDir: string, outputPath: string): { ok: true } | { ok: false; error: string } {
  try {
    unlinkSync(outputPath);
  } catch {
    // fine if it doesn't exist
  }

  mkdirSync(dirname(outputPath), { recursive: true });

  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -LiteralPath .modus,moves-export.json -DestinationPath '${outputPath.replace(/'/g, "''")}' -Force`,
      ],
      { cwd: sourceDir, encoding: "utf-8" },
    );
    if (result.status === 0) return { ok: true };
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || "Compress-Archive failed";
    return { ok: false, error: detail };
  }

  const result = spawnSync("zip", ["-qr", outputPath, "."], { cwd: sourceDir, encoding: "utf-8" });
  if (result.status === 0) return { ok: true };
  const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || "zip failed";
  return { ok: false, error: detail };
}

function defaultExportPath(projectDir: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return join(resolve(projectDir), `moves-export-${stamp}.zip`);
}

export function exportPortableMoves(projectDir: string, outPath?: string): ExportPortableMovesResult {
  const resolvedProjectDir = resolve(projectDir);
  const { moveNames } = collectPortableMoveEntries(resolvedProjectDir);

  if (moveNames.length === 0) {
    return { ok: false, error: `No project-local moves found in ${join(resolvedProjectDir, ".modus", "moves")}` };
  }

  const outputPath = resolve(outPath ?? defaultExportPath(resolvedProjectDir));
  const stageRoot = mkdtempSync(join(tmpdir(), "modus-moves-export-"));

  try {
    const staged = stagePortableMovesExport(stageRoot, resolvedProjectDir);
    const zipped = createZipFromDirectory(stageRoot, outputPath);
    if (!zipped.ok) return zipped;
    return {
      ok: true,
      outputPath,
      moveNames: staged.moveNames,
      fileCount: staged.fileCount,
    };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

export function describePortableMoves(projectDir: string): Array<{ name: string; description?: string }> {
  const movesDir = join(resolve(projectDir), ".modus", "moves");
  if (!existsSync(movesDir)) return [];

  const describedMoves: Array<{ name: string; description?: string }> = [];
  for (const entry of readdirSync(movesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const moveJsonPath = join(movesDir, entry.name, "move.json");
    if (!existsSync(moveJsonPath)) continue;
    describedMoves.push({
      name: entry.name,
      description: readMoveDescription(moveJsonPath),
    });
  }
  return describedMoves.sort((a, b) => a.name.localeCompare(b.name));
}

export function exportFileNameForProject(projectDir: string): string {
  return basename(defaultExportPath(projectDir));
}
