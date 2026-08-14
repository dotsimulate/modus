import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolveDeclaredMoveComponent } from "../move-component";
import type { MoveConfig } from "../move-types";

const move: MoveConfig = {
  name: "fixture",
  label: "Fixture",
  description: "Fixture move",
  widget: { component: "widget.tsx", label: "Fixture" },
  toolView: { component: "tool-view.tsx" },
};

describe("resolveDeclaredMoveComponent", () => {
  test("keeps the existing widget route default", () => {
    expect(resolveDeclaredMoveComponent(move)).toBe("widget.tsx");
  });

  test("allows either component declared by the move", () => {
    expect(resolveDeclaredMoveComponent(move, "widget.tsx")).toBe("widget.tsx");
    expect(resolveDeclaredMoveComponent(move, "tool-view.tsx")).toBe("tool-view.tsx");
  });

  test("rejects an undeclared component instead of treating it as a path", () => {
    expect(resolveDeclaredMoveComponent(move, "context.ts")).toBeNull();
    expect(resolveDeclaredMoveComponent(move, "../secrets.ts")).toBeNull();
  });

  test("does not make a tool-view-only move available at the legacy widget URL", () => {
    expect(resolveDeclaredMoveComponent({ ...move, widget: undefined })).toBeNull();
    expect(resolveDeclaredMoveComponent({ ...move, widget: undefined }, "tool-view.tsx")).toBe("tool-view.tsx");
  });
});

test("registers the static token resolver before the dynamic move route", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(source.indexOf('app.get("/api/moves/resolve-token"')).toBeGreaterThan(-1);
  expect(source.indexOf('app.get("/api/moves/resolve-token"')).toBeLessThan(
    source.indexOf('app.get("/api/moves/:name"'),
  );
});
