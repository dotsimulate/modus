import { resolve as resolveTestSourceDir } from "node:path";
/**
 * Contrast floors for the shipped themes.
 *
 * A colour token that body text can reach must be legible, and "looks fine on
 * my monitor" is not a check. These ratios are computed with the WCAG 2.x
 * relative-luminance formula, the same one an auditor would use.
 *
 * The two floors encode a rule, not just a number:
 *   --text-dim is the token for text a user has to READ, so it clears AA for
 *   normal text (4.5:1).
 *   --text-muted is for decoration — separators, inactive glyphs — so it only
 *   has to clear the 3:1 non-text floor. Anything a user must read should not
 *   be using it. It sat at 2.16:1 on modus-dark, under the session list's 10px
 *   profile column, which is how it was found.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const THEMES_DIR = join(resolveTestSourceDir(import.meta.dir, "..", "..", "ui"), "themes");

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function readTokens(file: string): Record<string, string> {
  const css = readFileSync(join(THEMES_DIR, file), "utf-8");
  const tokens: Record<string, string> = {};
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    // First declaration wins, matching the :root block these themes open with.
    if (!(match[1] in tokens)) tokens[match[1]] = match[2];
  }
  return tokens;
}

const themeFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));

describe("theme contrast", () => {
  test("there are themes to check", () => {
    expect(themeFiles.length).toBeGreaterThan(0);
  });

  for (const file of themeFiles) {
    describe(file, () => {
      const tokens = readTokens(file);
      const bg = tokens["--bg"];

      test("declares a background", () => {
        expect(bg).toMatch(/^#[0-9a-fA-F]{6}$/);
      });

      // Tokens body text is allowed to use, and the floor each must clear.
      const readable: Array<[string, number]> = [
        ["--text", 4.5],
        ["--text-secondary", 4.5],
        ["--text-label", 4.5],
        ["--text-tertiary", 4.5],
        ["--text-dim", 4.5],
        // Decoration only. Still has to be visible against the background.
        ["--text-muted", 3],
      ];

      for (const [token, floor] of readable) {
        test(`${token} clears ${floor}:1 on --bg`, () => {
          const value = tokens[token];
          expect(value, `${token} missing from ${file}`).toBeDefined();
          const ratio = contrastRatio(value, bg);
          // Reported to 2dp so a failure names the actual number to fix to.
          expect(
            Number(ratio.toFixed(2)),
            `${token} ${value} on ${bg} is ${ratio.toFixed(2)}:1, needs ${floor}:1`,
          ).toBeGreaterThanOrEqual(floor);
        });
      }

      // The ramp has to stay ordered, or "dim" and "muted" stop meaning
      // anything and a later fix reintroduces the failure by picking the
      // wrong-looking token.
      test("--text-muted is no brighter than --text-dim", () => {
        expect(contrastRatio(tokens["--text-muted"], bg))
          .toBeLessThanOrEqual(contrastRatio(tokens["--text-dim"], bg));
      });
    });
  }
});
