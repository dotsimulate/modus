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

/**
 * The other half of the setting: scaling the text is only safe if the box holds it.
 *
 * Sweeping every font-size to `calc(Npx * var(--font-scale, 1))` is a no-op at the
 * default scale of 1, which is what made it safe to land — and is also why nothing
 * catches a box that did not scale with it. A glyph button declared `height: 18px`
 * around 12px text fits at 1.0 and bleeds out of its own border at 1.75.
 *
 * So this checks the pairing: any rule that declares BOTH a scaled font-size and a
 * fixed px height must still fit its text at the maximum setting. Eight rules failed
 * this when it was written (icon buttons, a search input, the AskUserQuestion step
 * circles); all were fixed by scaling the box rather than un-scaling the text.
 *
 * Remedies when it fails, in preference order: scale the box the same way, or drop
 * the fixed height for intrinsic sizing (padding / min-height). Reverting the
 * font-size to a bare px is not one — the check above rejects that, correctly.
 */

/** settings.chat.fontScale is clamped 75..175 in interface-settings.ts and
 *  profile-schemas.ts, and --font-scale is that value / 100. */
const MAX_FONT_SCALE = 1.75;

/** Stand-in for `line-height: normal`, which is font-dependent (~1.15-1.2 for the
 *  faces used here). Deliberately generous so a borderline box is not called a pass. */
const NORMAL_LINE_HEIGHT = 1.35;

type Decl = { prop: string; value: string };
type Rule = { selector: string; decls: Decl[]; line: number };

/** Blank comments out in place, so brace matching is not fooled and lines still count. */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function declarations(body: string): Decl[] {
  const out: Decl[] = [];
  for (const chunk of body.split(";")) {
    const idx = chunk.indexOf(":");
    if (idx < 0) continue;
    const prop = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (!prop || prop.includes("{") || prop.includes("}")) continue;
    out.push({ prop, value });
  }
  return out;
}

/** Brace-balanced rule scan. Recurses into @media / @supports so nested rules are
 *  checked too rather than collapsing into one bogus block. */
function rules(css: string, lineBase = 0): Rule[] {
  const found: Rule[] = [];
  let depth = 0;
  let selectorStart = 0;
  let blockStart = -1;
  const lineAt = (index: number) => css.slice(0, index).split("\n").length + lineBase;

  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth !== 0 || blockStart < 0) continue;
      const selector = css.slice(selectorStart, blockStart).trim().replace(/\s+/g, " ");
      const body = css.slice(blockStart + 1, i);
      if (selector.startsWith("@")) found.push(...rules(body, lineAt(blockStart) - 1));
      else found.push({ selector, decls: declarations(body), line: lineAt(blockStart) });
      selectorStart = i + 1;
      blockStart = -1;
    }
  }
  return found;
}

const pxValue = (value: string) => Number(/(-?[0-9.]+)px/.exec(value)?.[1] ?? "0");

/** A length that will not grow with the setting: a px literal, no scale, no relative unit. */
function isFixedPx(value: string): boolean {
  if (value.includes("--font-scale")) return false;
  if (/%|vh|vw|em\b|rem\b|calc|min\(|max\(/.test(value)) return false;
  return /[0-9]px/.test(value);
}

/** Content height available for text. box-sizing is border-box globally (theme.css),
 *  so borders and vertical padding come out of the declared height. */
function contentHeight(declaredPx: number, decls: Decl[]): number {
  let inset = 0;
  for (const d of decls) {
    if (d.prop === "border" && !d.value.includes("none")) inset += (pxValue(d.value) || 1) * 2;
    if (d.prop === "border-top" || d.prop === "border-bottom") inset += pxValue(d.value) || 1;
  }
  const padding = decls.find((d) => d.prop === "padding");
  if (padding) inset += pxValue(padding.value.split(/\s+/)[0]) * 2;
  return declaredPx - inset;
}

/** Returns a complaint string per rule whose fixed height cannot hold its own text
 *  at MAX_FONT_SCALE, or [] if every pairing fits. */
function overflowingRules(css: string, label: string): string[] {
  const offenders: string[] = [];
  for (const rule of rules(blankComments(css))) {
    const font = rule.decls.find((d) => d.prop === "font-size" && d.value.includes("--font-scale"));
    const height = rule.decls.find((d) => d.prop === "height" && isFixedPx(d.value));
    if (!font || !height) continue;

    const fontPx = pxValue(font.value);
    const lhDecl = rule.decls.find((d) => d.prop === "line-height");
    let lineHeight = NORMAL_LINE_HEIGHT;
    if (lhDecl) {
      const ratio = lhDecl.value.includes("px") ? pxValue(lhDecl.value) / fontPx : Number(lhDecl.value);
      if (Number.isFinite(ratio) && ratio > 0) lineHeight = ratio;
    }

    const needed = fontPx * MAX_FONT_SCALE * lineHeight;
    const available = contentHeight(pxValue(height.value), rule.decls);
    if (needed > available) {
      offenders.push(
        `${label}:${rule.line}  ${rule.selector} — ${fontPx}px text needs `
          + `${needed.toFixed(1)}px at ${MAX_FONT_SCALE}x but the box gives ${available}px`,
      );
    }
  }
  return offenders;
}

describe("font-scale box fit", () => {
  test("no fixed-height box clips its own scaled text at the maximum setting", () => {
    const offenders: string[] = [];
    for (const file of cssFiles(STYLES_DIR)) {
      const label = relative(STYLES_DIR, file).replace(/\\/g, "/");
      offenders.push(...overflowingRules(readFileSync(file, "utf-8"), label));
    }
    expect(
      offenders,
      `These boxes do not grow with the text they contain, so raising the text-size `
        + `setting pushes the text out of them. Scale the box the same way, or replace `
        + `the fixed height with intrinsic sizing:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  // Proves the check can actually fail, so a green run means something.
  test("the check recognises a violation", () => {
    const bad = `.glyph-btn { height: 18px; font-size: calc(12px * var(--font-scale, 1)); line-height: 1; }`;
    expect(overflowingRules(bad, "x.css")).toHaveLength(1);

    const scaled = `.glyph-btn { height: calc(18px * var(--font-scale, 1)); font-size: calc(12px * var(--font-scale, 1)); line-height: 1; }`;
    expect(overflowingRules(scaled, "x.css")).toEqual([]);

    const roomy = `.tall-btn { height: 40px; font-size: calc(11px * var(--font-scale, 1)); }`;
    expect(overflowingRules(roomy, "x.css")).toEqual([]);

    // A border eats into the height under border-box, which can flip the verdict.
    const bordered = `.circle { width: 22px; height: 22px; border: 1px solid red; font-size: calc(9px * var(--font-scale, 1)); }`;
    expect(overflowingRules(bordered, "x.css")).toHaveLength(1);

    // Nested rules inside @media are checked, not swallowed by the at-rule block.
    const nested = `@media (max-width: 640px) { .glyph-btn { height: 18px; font-size: calc(12px * var(--font-scale, 1)); line-height: 1; } }`;
    expect(overflowingRules(nested, "x.css")).toHaveLength(1);
  });
});
