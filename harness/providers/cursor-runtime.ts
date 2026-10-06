import { execFile } from "child_process";
import { promisify, stripVTControlCharacters } from "util";
import { resolveSecret } from "../secrets";
import { providerChildEnv } from "./child-env";
import { cursorAgentSpawnArgv0 } from "./cursor-resolve-bin";

/** Model discovery and turns must use the same Cursor credentials. */
export function cursorEnvironment(
  apiKey = resolveSecret("CURSOR_API_KEY"),
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = providerChildEnv(base);
  if (apiKey) env.CURSOR_API_KEY = apiKey;
  return env;
}

export function parseCursorModels(raw: string): { id: string; owned_by: "cursor" }[] {
  const ids = new Set<string>();
  for (const line of stripVTControlCharacters(raw).split(/\r?\n/)) {
    const match = /^(\S+)\s+-\s+.+$/.exec(line.trim());
    if (match) ids.add(match[1]!);
  }
  return [...ids].map((id) => ({ id, owned_by: "cursor" }));
}

async function runCursorModels(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await promisify(execFile)(bin, ["models"], {
    env,
    timeout: 15_000,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

export async function fetchCursorModels(run = runCursorModels) {
  let raw: string;
  try {
    raw = await run(cursorAgentSpawnArgv0(), cursorEnvironment());
  } catch (error: any) {
    // Do not expose arbitrary CLI diagnostics: they can include credentials.
    const diagnostic = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`;
    if (/authentication required|unauthenticated|not authenticated|login required/i.test(diagnostic)) {
      throw new Error("Cursor sign-in required. Run cursor-agent login, then reload the model picker, or configure CURSOR_API_KEY in Modus.");
    }
    if (error?.code === "ENOENT") {
      throw new Error("Cursor CLI not found. Install cursor-agent or configure CURSOR_AGENT_BIN.");
    }
    if (error?.killed || error?.code === "ETIMEDOUT") {
      throw new Error("Cursor model discovery timed out. Check your connection and try again.");
    }
    throw new Error("Cursor model discovery failed. Check cursor-agent models in a terminal.");
  }
  const models = parseCursorModels(raw);
  if (!models.length) {
    throw new Error("Cursor returned no model suggestions. Check cursor-agent models in a terminal.");
  }
  return models;
}
