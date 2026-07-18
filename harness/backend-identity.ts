import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { APP_PATHS } from "./app-paths";

export type BackendIdentity = {
  id: string;
  host: string;
  instance: string;
};

const identityPath = join(APP_PATHS.dataDir, "backend-identity.json");

function readIdentityId(): string | null {
  try {
    const value = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
    return typeof value.id === "string" && /^[0-9a-f-]{36}$/i.test(value.id) ? value.id : null;
  } catch {
    return null;
  }
}

function resolveIdentityId(): string {
  const existing = readIdentityId();
  if (existing) return existing;
  mkdirSync(APP_PATHS.dataDir, { recursive: true });
  const id = crypto.randomUUID();
  try {
    writeFileSync(identityPath, `${JSON.stringify({ id }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return id;
  } catch {
    // Another daemon may have created the identity between our read and write.
    return readIdentityId() ?? id;
  }
}

export const BACKEND_IDENTITY: BackendIdentity = {
  id: resolveIdentityId(),
  host: hostname(),
  instance: APP_PATHS.instance ?? "default",
};
