import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_SCOPE = join(import.meta.dir, "..", "..", "ui", "src", "components", "pageScope.tsx");

function functionBody(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`export function ${name}`);
  const end = source.indexOf(`export function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("page-scoped session selection", () => {
  it("forwards bus selection synchronously instead of waiting for a React commit", () => {
    const source = readFileSync(PAGE_SCOPE, "utf8");
    const binder = functionBody(source, "ScopeUrlSessionBinder", "ScopeSelectSessionIntentBridge");

    expect(binder).toContain("return bus.subscribe(() => {");
    expect(binder).toContain("bus.onSelectSession(sid)");
    expect(binder).not.toContain("useSyncExternalStore");

    const prime = binder.indexOf("lastPushed.current = next;");
    const inboundSet = binder.indexOf('bus.set("sessionId", next)');
    expect(prime).toBeGreaterThanOrEqual(0);
    expect(inboundSet).toBeGreaterThan(prime);
  });
});
