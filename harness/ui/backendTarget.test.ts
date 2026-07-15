import { describe, expect, test } from "bun:test";
import { normalizeBackendUrl, resolveBackendTarget } from "./src/backendTarget";

describe("desktop backend target", () => {
  test("defaults the browser client to same-origin", () => {
    expect(resolveBackendTarget({ pageOrigin: "http://localhost:3777" })).toEqual({
      id: "browser:http://localhost:3777",
      label: "This browser",
      mode: "browser",
      apiBase: "",
    });
  });

  test("accepts an external backend from the desktop launch URL", () => {
    const target = resolveBackendTarget({
      search: "?modusTarget=http%3A%2F%2F127.0.0.1%3A3777&modusTargetMode=external-local&modusTargetLabel=Local+Modus",
    });
    expect(target).toEqual({
      id: "external-local:http://127.0.0.1:3777",
      label: "Local Modus",
      mode: "external-local",
      apiBase: "http://127.0.0.1:3777",
    });
  });

  test("rejects credentials and non-origin target paths", () => {
    expect(() => normalizeBackendUrl("http://user:secret@localhost:3777")).toThrow();
    expect(() => normalizeBackendUrl("https://host.example/api")).toThrow();
  });
});
