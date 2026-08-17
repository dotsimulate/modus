/**
 * Widget metadata and widget components live in two files, so they can drift.
 *
 * `catalog.ts` holds every widget's metadata and imports no components, which
 * is what lets the page linter and the docs generator read it without pulling
 * React into a test process. `registry.ts` binds the components. A widget
 * present in one and absent from the other fails silently: a catalog entry with
 * no component is filtered out of `WIDGET_DEFS` and simply never appears in the
 * picker, and a component with no catalog entry is unreachable by page JSON.
 *
 * `registry.ts` is read as source rather than imported, because importing it
 * pulls in CodeMirror, xterm, and mermaid — none of which survive a DOM-less
 * test process. This is the same approach `fontScale.test.ts` takes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { WIDGET_META, UNDESCRIBED_WIDGETS } from "../../ui/src/widgets/catalog";

const registrySource = readFileSync(
  join(import.meta.dir, "..", "..", "ui", "src", "widgets", "registry.ts"),
  "utf8",
);

/** Keys of the WIDGET_COMPONENTS object literal in registry.ts. */
function componentKeys(): string[] {
  const start = registrySource.indexOf("export const WIDGET_COMPONENTS");
  expect(start).toBeGreaterThan(-1);
  const body = registrySource.slice(start, registrySource.indexOf("};", start));
  return [...body.matchAll(/^\s*"([^"]+)":\s*\w+,/gm)].map((match) => match[1]!);
}

describe("catalog and registry agree", () => {
  const components = componentKeys();
  const metaTypes = Object.keys(WIDGET_META);

  test("registry binds a component for every catalog entry", () => {
    const missing = metaTypes.filter((type) => !components.includes(type));
    expect(missing).toEqual([]);
  });

  test("every bound component has a catalog entry", () => {
    const orphaned = components.filter((type) => !metaTypes.includes(type));
    expect(orphaned).toEqual([]);
  });

  test("each entry's `type` matches the key it is filed under", () => {
    const mismatched = metaTypes.filter((type) => WIDGET_META[type]?.type !== type);
    expect(mismatched).toEqual([]);
  });

  test("the catalog is not empty", () => {
    expect(metaTypes.length).toBeGreaterThan(30);
  });
});

describe("descriptions", () => {
  test("a widget's description gap is reported, not invented", () => {
    // This is a real backlog, not a failure — the count is allowed to fall but
    // an entry must never gain a description that nobody wrote.
    for (const type of UNDESCRIBED_WIDGETS) {
      expect(WIDGET_META[type]?.description).toBeUndefined();
    }
  });

  test("most widgets are described", () => {
    const described = Object.values(WIDGET_META).filter((meta) => meta.description).length;
    expect(described).toBeGreaterThan(Object.keys(WIDGET_META).length / 2);
  });

  test("declared config keys carry a name, a type, and a description", () => {
    const broken: string[] = [];
    for (const [type, meta] of Object.entries(WIDGET_META)) {
      for (const key of meta.config ?? []) {
        if (!key.name || !key.type || !key.description) broken.push(`${type}.${key.name}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
