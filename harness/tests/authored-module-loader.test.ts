import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { importAuthoredModule } from "../authored-module-loader";

const root = mkdtempSync(join(tmpdir(), "modus-authored-loader-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const counters = globalThis as unknown as Record<string, number>;

/** A unit dir with a context.ts that counts its own evaluations under `key`. */
function writeUnit(name: string, body: string[]): { dir: string; entry: string; key: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const key = `__authoredLoader_${name}`;
  const entry = join(dir, "context.ts");
  writeFileSync(entry, [
    `(globalThis as any)[${JSON.stringify(key)}] = ((globalThis as any)[${JSON.stringify(key)}] ?? 0) + 1;`,
    ...body,
  ].join("\n"));
  return { dir, entry, key };
}

describe("authored module loader", () => {
  test("repeated loads evaluate the module once", async () => {
    const unit = writeUnit("repeat", ['export const value = "one";']);
    for (let i = 0; i < 25; i++) {
      const mod = await importAuthoredModule<{ value: string }>(unit.entry, { unitDir: unit.dir });
      expect(mod.value).toBe("one");
    }
    expect(counters[unit.key]).toBe(1);
  });

  test("editing the entry or a sibling import reloads it", async () => {
    const unit = writeUnit("edit", ['import { sibling } from "./sibling";', "export const value = sibling;"]);
    writeFileSync(join(unit.dir, "sibling.ts"), 'export const sibling = "first";\n');
    const load = () => importAuthoredModule<{ value: string }>(unit.entry, { unitDir: unit.dir });

    expect((await load()).value).toBe("first");
    expect((await load()).value).toBe("first");
    expect(counters[unit.key]).toBe(1);

    writeFileSync(join(unit.dir, "sibling.ts"), 'export const sibling = "second!";\n');
    expect((await load()).value).toBe("second!");
    expect(counters[unit.key]).toBe(2);

    writeFileSync(unit.entry, [
      `(globalThis as any)[${JSON.stringify(unit.key)}] = ((globalThis as any)[${JSON.stringify(unit.key)}] ?? 0) + 1;`,
      'import { sibling } from "./sibling";',
      'export const value = `${sibling} (entry edited)`;',
    ].join("\n"));
    expect((await load()).value).toBe("second! (entry edited)");
    expect((await load()).value).toBe("second! (entry edited)");
    expect(counters[unit.key]).toBe(3);
  });

  test("a reload does not re-evaluate modules outside the unit directory", async () => {
    const sharedDir = join(root, "shared");
    mkdirSync(sharedDir, { recursive: true });
    const sharedKey = "__authoredLoader_sharedDep";
    writeFileSync(join(sharedDir, "dep.ts"), [
      `(globalThis as any).${sharedKey} = ((globalThis as any).${sharedKey} ?? 0) + 1;`,
      "export const dep = 42;",
    ].join("\n"));
    const unit = writeUnit("uses-shared", ['import { dep } from "../shared/dep";', "export const value = dep;"]);
    const load = () => importAuthoredModule<{ value: number }>(unit.entry, { unitDir: unit.dir });

    expect((await load()).value).toBe(42);
    writeFileSync(unit.entry, [
      'import { dep } from "../shared/dep";',
      "export const value = dep + 1;",
    ].join("\n"));
    expect((await load()).value).toBe(43);
    expect(counters[sharedKey]).toBe(1);
  });

  test("a failed import is not retried until the source changes", async () => {
    const unit = writeUnit("broken", ['throw new Error("broken on purpose");']);
    const load = () => importAuthoredModule<{ value: string }>(unit.entry, { unitDir: unit.dir });

    await expect(load()).rejects.toThrow("broken on purpose");
    await expect(load()).rejects.toThrow("broken on purpose");
    await expect(load()).rejects.toThrow("broken on purpose");
    expect(counters[unit.key]).toBe(1);

    writeFileSync(unit.entry, [
      `(globalThis as any)[${JSON.stringify(unit.key)}] = ((globalThis as any)[${JSON.stringify(unit.key)}] ?? 0) + 1;`,
      'export const value = "fixed";',
    ].join("\n"));
    expect((await load()).value).toBe("fixed");
    expect((await load()).value).toBe("fixed");
    expect(counters[unit.key]).toBe(2);
  });

  test("a watched path change forces a reload", async () => {
    const unit = writeUnit("watched", ['export const value = "watched";']);
    const marker = join(unit.dir, "package.json");
    const load = () => importAuthoredModule<{ value: string }>(unit.entry, { unitDir: unit.dir, watchPaths: [marker] });

    await load();
    await load();
    expect(counters[unit.key]).toBe(1);
    writeFileSync(marker, "{}\n");
    await load();
    await load();
    expect(counters[unit.key]).toBe(2);
  });

  test("creating a missing local dependency recovers a failed import", async () => {
    const unit = writeUnit("missing-dependency", ['export { value } from "./missing";']);
    const load = () => importAuthoredModule<{ value: number }>(unit.entry, { unitDir: unit.dir });
    await expect(load()).rejects.toThrow();
    writeFileSync(join(unit.dir, "missing.ts"), "export const value = 42;");
    const recovered = await load();
    expect(recovered.value).toBe(42);
    writeFileSync(join(unit.dir, "runtime.json"), '{"ticks":1}');
    expect(await load()).toBe(recovered);
  });

  test("fixing a syntax error in an existing dependency recovers the entry", async () => {
    const unit = writeUnit("syntax-dependency", ['export { value } from "./dependency";']);
    const dependency = join(unit.dir, "dependency.ts");
    writeFileSync(dependency, "export const value = ;");
    const load = () => importAuthoredModule<{ value: number }>(unit.entry, { unitDir: unit.dir });
    await expect(load()).rejects.toThrow();
    writeFileSync(dependency, "export const value = 123;");
    expect((await load()).value).toBe(123);
  });

  test("concurrent loads share one evaluation", async () => {
    const unit = writeUnit("concurrent", ['export const value = "shared";']);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => importAuthoredModule<{ value: string }>(unit.entry, { unitDir: unit.dir })),
    );
    expect(results.every((mod) => mod.value === "shared")).toBe(true);
    expect(counters[unit.key]).toBe(1);
  });
});
