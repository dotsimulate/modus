/**
 * Terminal presentation for the harness supervisor token.
 *
 * `HARNESS_TOKEN` authenticates every Modus API, including the file and profile
 * surfaces. The CLI banner prints directly beside the URLs users are asked to
 * copy into bug reports, and a raw hex string does not read as a credential, so
 * it is masked unless the operator explicitly asks for it.
 */

/** Format the supervisor token for a CLI banner line. */
export function formatTokenForBanner(token: string, source: string, reveal: boolean): string {
  if (!token) return `none (${source})`;
  if (reveal) return `${token} (${source})`;
  return `set (${source}) — reveal with: modus start --show-token`;
}
