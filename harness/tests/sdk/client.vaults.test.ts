import { afterEach, describe, expect, test } from "bun:test";
import { ModusClient } from "../../sdk/client";
import { ALLOW_ALL_POLICY, DENY_ALL_POLICY } from "../../vault-policy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ModusClient Vault API", () => {
  test("uses the registry and policy routes with encoded slugs", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const responses: unknown[] = [
      { current: null, vaults: [{ slug: null }] },
      { slug: "private space", name: "Private", createdAt: 100 },
      { slug: "private space", name: "Private", createdAt: 100 },
      { slug: "private space", name: "Renamed", createdAt: 100, autostart: true },
      DENY_ALL_POLICY,
      ALLOW_ALL_POLICY,
    ];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      return Response.json(responses.shift());
    }) as typeof fetch;

    const client = new ModusClient({ url: "https://modus.example" });
    expect(await client.listVaults()).toEqual({ current: null, vaults: [{ slug: null }] });
    expect(await client.createVault("private space", "D:/Vaults/Private", "initialize", "Private"))
      .toMatchObject({ name: "Private" });
    expect(await client.repairVault("private space", "D:/Vaults/Private", "register"))
      .toMatchObject({ name: "Private" });
    expect(await client.updateVault("private space", { name: "Renamed", autostart: true })).toMatchObject({ autostart: true });
    expect(await client.getVaultPolicy(null)).toEqual(DENY_ALL_POLICY);
    expect(await client.setVaultPolicy("private space", ALLOW_ALL_POLICY)).toEqual(ALLOW_ALL_POLICY);

    expect(requests).toEqual([
      { url: "https://modus.example/api/vaults", method: "GET" },
      {
        url: "https://modus.example/api/vaults",
        method: "POST",
        body: { slug: "private space", root: "D:/Vaults/Private", mode: "initialize", name: "Private" },
      },
      {
        url: "https://modus.example/api/vaults/private%20space/repair",
        method: "POST",
        body: { root: "D:/Vaults/Private", mode: "register" },
      },
      {
        url: "https://modus.example/api/vaults/private%20space",
        method: "PATCH",
        body: { name: "Renamed", autostart: true },
      },
      { url: "https://modus.example/api/vaults/default/policy", method: "GET" },
      {
        url: "https://modus.example/api/vaults/private%20space/policy",
        method: "PUT",
        body: ALLOW_ALL_POLICY,
      },
    ]);
  });
});
