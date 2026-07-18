/**
 * SVG → PNG rendering via resvg (Rust-based, high spec coverage).
 * Shared utility for actions and any backend that needs SVG rasterization.
 *
 * IMPORTANT: resvg runs in a subprocess to isolate Rust panics.
 * A native assertion failure (e.g. displacement_map filter edge case)
 * will kill only the child process, not the harness.
 */

import { spawnSync } from "child_process";
import { join } from "path";
import { APP_PATHS } from "./app-paths";

const WORKER_PATH = join(
  APP_PATHS.resourcesDir,
  process.env.MODUS_DESKTOP_MANAGED ? "svg-render-worker.js" : "svg-render-worker.ts",
);

export function svgToPngBase64(svgPath: string, width = 800): string | null {
  try {
    const result = spawnSync(process.execPath, [WORKER_PATH, svgPath, String(width)], {
      timeout: 10_000,
      maxBuffer: 50 * 1024 * 1024, // 50MB for large PNGs
    });
    if (result.status !== 0) return null;
    return result.stdout.toString("utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function svgFileToPng(svgPath: string, width = 800): Buffer | null {
  const b64 = svgToPngBase64(svgPath, width);
  return b64 ? Buffer.from(b64, "base64") : null;
}
