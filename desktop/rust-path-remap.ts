import { resolve } from "node:path";

const ENCODED_FLAG_SEPARATOR = "\u001f";

export interface RustPathRemapOptions {
  repositoryDir: string;
  environment?: Record<string, string | undefined>;
}

function addPathRemap(
  flags: string[],
  seen: Set<string>,
  source: string | undefined,
  destination: string,
): void {
  if (!source?.trim()) return;
  const absolute = resolve(source);
  for (const prefix of [absolute, absolute.replaceAll("\\", "/")]) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    flags.push(`--remap-path-prefix=${prefix}=${destination}`);
  }
}

/**
 * Build a Cargo environment that keeps host paths out of release artifacts.
 * More-specific prefixes are added last because rustc applies the last match.
 */
export function releaseRustEnvironment({
  repositoryDir,
  environment = process.env,
}: RustPathRemapOptions): Record<string, string | undefined> {
  const incompatible = Object.entries(environment)
    .filter(([name, value]) => value?.trim() && name !== "CARGO_ENCODED_RUSTFLAGS")
    .filter(([name]) => name === "RUSTFLAGS"
      || name === "CARGO_BUILD_RUSTFLAGS"
      || /^CARGO_TARGET_.+_RUSTFLAGS$/.test(name));
  if (incompatible.length > 0) {
    throw new Error(
      `Release builds require encoded Rust flags; unset ${incompatible.map(([name]) => name).join(", ")} `
      + "or move those flags to CARGO_ENCODED_RUSTFLAGS.",
    );
  }

  const flags = environment.CARGO_ENCODED_RUSTFLAGS
    ?.split(ENCODED_FLAG_SEPARATOR)
    .filter(Boolean) ?? [];
  const seen = new Set<string>();
  const home = environment.USERPROFILE?.trim() || environment.HOME?.trim();

  addPathRemap(flags, seen, home, "/user");
  addPathRemap(flags, seen, environment.CARGO_HOME?.trim() || (home ? resolve(home, ".cargo") : undefined), "/cargo");
  addPathRemap(flags, seen, environment.RUSTUP_HOME?.trim() || (home ? resolve(home, ".rustup") : undefined), "/rustup");
  addPathRemap(flags, seen, repositoryDir, "/modus/source");

  return {
    ...environment,
    CARGO_ENCODED_RUSTFLAGS: flags.join(ENCODED_FLAG_SEPARATOR),
  };
}
