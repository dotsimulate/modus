/**
 * Subprocess worker for SVG → PNG rendering.
 * Runs resvg in isolation so native panics can't crash the parent process.
 * Usage: bun svg-render-worker.ts <svg-path> [width]
 * Outputs base64-encoded PNG to stdout.
 */

import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "fs";

const svgPath = process.argv[2];
const width = parseInt(process.argv[3] || "800");

if (!svgPath) {
  process.exit(1);
}

try {
  const svg = readFileSync(svgPath, "utf-8");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
  });
  const rendered = resvg.render();
  const png = Buffer.from(rendered.asPng());
  process.stdout.write(png.toString("base64"));
} catch {
  process.exit(1);
}
