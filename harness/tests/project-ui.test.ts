import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { activateTheme, listThemes } from "../project-ui";

const cwd = mkdtempSync(join(tmpdir(), "modus-project-ui-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

test("built-in themes are available and activatable", () => {
  const themes = listThemes(cwd);
  expect(themes.map((theme) => theme.id)).toEqual([
    "modus-dark",
    "modus-light",
    "modus-graphite",
  ]);
  expect(themes.every((theme) => existsSync(theme.absolutePath))).toBe(true);

  for (const theme of themes) {
    const active = activateTheme(cwd, theme.id);
    expect(active.id).toBe(theme.id);
    expect(active.variables["--bg"]).toBeTruthy();
    expect(active.variables["--text"]).toBeTruthy();
    expect(active.variables["--accent"]).toBeTruthy();
    expect(active.variables["--border"]).toBeTruthy();
  }
});
