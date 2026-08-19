import { describe, expect, test } from "bun:test";
import {
  BACKEND_TARGET,
  configureBackendTarget,
  normalizeBackendUrl,
  resolveBackendTarget,
} from "../../ui/src/backendTarget";
import {
  backendIdentityChanged,
  getActiveBackendTarget,
  loadBackendTargets,
  normalizeRemoteBackendUrl,
  rememberBackendConnected,
  saveRemoteBackendTarget,
  targetSearchParams,
} from "../../ui/src/backend-targets";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

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

  test("rebinds an eagerly evaluated production target after the desktop handshake", () => {
    const target = configureBackendTarget({
      search: "?modusTarget=http%3A%2F%2F127.0.0.1%3A62240&modusTargetId=local&modusTargetMode=managed-local&modusTargetLabel=Main",
      pageOrigin: "http://tauri.localhost",
    });

    expect(target).toBe(BACKEND_TARGET);
    expect(BACKEND_TARGET).toEqual({
      id: "local",
      label: "Main",
      mode: "managed-local",
      apiBase: "http://127.0.0.1:62240",
      vaultSlug: null,
    });
  });

  test("resolves a named managed Vault from the window URL", () => {
    expect(resolveBackendTarget({
      search: "?modusTarget=http%3A%2F%2F127.0.0.1%3A62241&modusTargetId=vault%3Aprivate&modusTargetMode=managed-local&modusTargetLabel=Private&modusVault=private",
    })).toEqual({
      id: "vault:private",
      label: "Private",
      mode: "managed-local",
      apiBase: "http://127.0.0.1:62241",
      vaultSlug: "private",
    });
  });

  test("rejects credentials and non-origin target paths", () => {
    expect(() => normalizeBackendUrl("http://user:secret@localhost:3777")).toThrow();
    expect(() => normalizeBackendUrl("https://host.example/api")).toThrow();
  });

  test("requires HTTPS for non-local remote targets", () => {
    expect(normalizeRemoteBackendUrl("https://modus-host.example.ts.net/"))
      .toBe("https://modus-host.example.ts.net");
    expect(() => normalizeRemoteBackendUrl("http://100.64.0.8:3777")).toThrow("Tailscale Serve");
  });

  test("persists remote targets and backend identities separately from local", () => {
    const storage = new MemoryStorage();
    const saved = saveRemoteBackendTarget("Remote Modus", "https://modus-host.example.ts.net", storage);
    rememberBackendConnected({ ...saved, backendId: "backend-remote" }, storage);

    expect(getActiveBackendTarget(storage)).toMatchObject({
      id: "remote:https://modus-host.example.ts.net",
      label: "Remote Modus",
      backendId: "backend-remote",
    });
    expect(loadBackendTargets(storage).map((target) => target.id)).toEqual([
      "local",
      "external-local",
      "remote:https://modus-host.example.ts.net",
    ]);
  });

  test("builds a clean launch query when switching targets", () => {
    const params = targetSearchParams({
      id: "remote:https://modus-host.example.ts.net",
      label: "Remote Modus",
      mode: "remote",
      url: "https://modus-host.example.ts.net",
    }, "?modusDiscover=local&cwd=D%3A%5Cproject");
    expect(params.get("modusTarget")).toBe("https://modus-host.example.ts.net");
    expect(params.get("modusTargetId")).toBe("remote:https://modus-host.example.ts.net");
    expect(params.has("cwd")).toBe(false);
  });

  test("fails closed when a pinned backend changes or omits its identity", () => {
    expect(backendIdentityChanged("one", "two")).toBe(true);
    expect(backendIdentityChanged("one", "one")).toBe(false);
    expect(backendIdentityChanged("one", undefined)).toBe(true);
    expect(backendIdentityChanged("", "replacement")).toBe(false);
    expect(backendIdentityChanged(undefined, "one")).toBe(false);
    expect(backendIdentityChanged(undefined, undefined)).toBe(false);
  });

  test("persists a named Vault target and emits its desktop bootstrap identity", () => {
    const storage = new MemoryStorage();
    rememberBackendConnected({
      id: "vault:private",
      label: "Private",
      mode: "managed-local",
      vaultSlug: "private",
    }, storage);

    expect(getActiveBackendTarget(storage)).toMatchObject({
      id: "vault:private",
      vaultSlug: "private",
    });
    const params = targetSearchParams(getActiveBackendTarget(storage));
    expect(params.get("modusTargetMode")).toBe("managed-local");
    expect(params.get("modusVault")).toBe("private");
    expect(params.get("modusTargetId")).toBe("vault:private");
  });
});
