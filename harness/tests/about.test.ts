import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { getAboutInfo, resolveVersion, MODUS_LICENSE } from "../about";

describe("about", () => {
  test("uses the version the desktop shell stamps on the managed backend", () => {
    expect(resolveVersion({ MODUS_DESKTOP_VERSION: "1.2.3" })).toEqual({
      version: "1.2.3",
      source: "desktop",
    });
  });

  test("admits an unknown version rather than inventing one", () => {
    // A browser-only `modus start` is not stamped by any build. Reporting a
    // plausible number would send bug reports to a build that does not exist.
    for (const env of [{}, { MODUS_DESKTOP_VERSION: "" }, { MODUS_DESKTOP_VERSION: "   " }]) {
      expect(resolveVersion(env)).toEqual({ version: "development", source: "unknown" });
    }
  });

  test("every help topic points at a document that ships with this build", () => {
    // The whole point of referencing doc ids instead of restating them is that
    // they stay version-matched. A renamed doc must fail here, not render a
    // dead link in three separate surfaces.
    const missing = getAboutInfo().topics
      .map((topic) => topic.docId)
      .filter((id): id is string => Boolean(id))
      .filter((id) => !existsSync(join(resolveTestSourceDir(import.meta.dir, ".."), "docs", `${id}.md`)));
    expect(missing).toEqual([]);
  });

  test("exposes the real license and a link for each external reference", () => {
    const info = getAboutInfo();
    expect(info.license).toBe(MODUS_LICENSE);
    expect(info.links.length).toBeGreaterThan(0);
    for (const link of info.links) {
      expect(link.label).not.toBe("");
      expect(link.description).not.toBe("");
      expect(link.href === "#docs" || link.href.startsWith("https://")).toBe(true);
    }
  });

  test("does not claim configured providers and integrations are local", () => {
    const aboutCopy = getAboutInfo().topics.map((topic) => topic.body).join("\n");
    const tauriConfig = JSON.parse(readFileSync(
      resolve(resolveTestSourceDir(import.meta.dir, ".."), "../desktop/src-tauri/tauri.conf.json"),
      "utf8",
    )) as { bundle: { longDescription: string } };
    const userFacingCopy = `${aboutCopy}\n${tauriConfig.bundle.longDescription}`;

    expect(userFacingCopy).not.toMatch(/everything runs locally/i);
    expect(userFacingCopy).toMatch(/providers and integrations/i);
  });
});
