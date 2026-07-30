/**
 * Guard for the text-size setting.
 *
 * `--font-scale` is set once from settings.chat.fontScale and stylesheets opt in
 * per declaration with `calc(Npx * var(--font-scale, 1))`. Opting in is easy to
 * forget and impossible to notice: a hardcoded size renders perfectly at the
 * default scale of 1, so the setting silently does nothing on that surface and
 * only a user who changes it ever finds out.
 *
 * Adoption was about half the app — roughly 40 stylesheets had zero scaled
 * sizes — until it was swept. This keeps it swept. A new hardcoded px font-size
 * fails here rather than quietly reintroducing the dead zone.
 *
 * Relative units (em, rem, %) are fine: they inherit from a scaled ancestor.
 * `max(16px, calc(16px * var(--font-scale, 1)))` is also fine and is the iOS
 * Safari auto-zoom floor — only a *bare* px literal is rejected.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

const STYLES_DIR = join(import.meta.dir, "src/styles");

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/** A font-size whose value is a bare px literal, e.g. `font-size: 12px;`. */
const BARE_PX = /font-size:\s*[0-9.]+px\s*(?:;|})/g;

describe("font-scale adoption", () => {
  const files = cssFiles(STYLES_DIR);

  test("there are stylesheets to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no stylesheet hardcodes a px font-size", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, "utf-8");
      for (const match of css.matchAll(BARE_PX)) {
        const line = css.slice(0, match.index).split("\n").length;
        offenders.push(`${relative(STYLES_DIR, file).replace(/\\/g, "/")}:${line}  ${match[0].trim()}`);
      }
    }
    expect(
      offenders,
      `Hardcoded font sizes ignore the text-size setting. Use `
        + `calc(Npx * var(--font-scale, 1)):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  // Proves the check can actually fail, so a green run means something.
  test("the check recognises a violation", () => {
    expect("  font-size: 12px;\n".match(BARE_PX)).not.toBeNull();
    expect("  font-size: 12.5px }".match(BARE_PX)).not.toBeNull();
    expect("  font-size: calc(12px * var(--font-scale, 1));".match(BARE_PX)).toBeNull();
    expect("  font-size: max(16px, calc(16px * var(--font-scale, 1)));".match(BARE_PX)).toBeNull();
    expect("  font-size: 1.2em;".match(BARE_PX)).toBeNull();
  });
});
