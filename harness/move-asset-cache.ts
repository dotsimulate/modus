/**
 * Cache validators for move-authored browser assets (`widget`, `widget.css`).
 *
 * These are served from a URL that carries no version, hash, or mtime —
 * `/api/moves/<name>/widget?cwd=<cwd>` is stable for the life of a move. The
 * server rebuilds on mtime change, but with no `Cache-Control` and no `ETag`
 * nothing ever told the browser that, so a client was free to reuse a bundle
 * indefinitely under heuristic caching and never observe an authored edit.
 *
 * That is not a cosmetic staleness problem. A stale widget keeps calling a
 * *current* server, so an authored change to a request URL, an auth parameter,
 * or an op name breaks only on the clients that cached the old code — which
 * presents as "the fix works on this machine but not that one" and sends you
 * hunting the server. It cost a real diagnosis: a phone stranded on a widget
 * whose URL builder omitted the `token=` key, 401ing against a backend that had
 * already been fixed.
 *
 * `no-cache` means revalidate before reuse, not do-not-store. Paired with the
 * ETag the common case is a 304 with no body, so correctness costs a round trip
 * rather than a rebuild and a re-download.
 */

/**
 * Validator derived from the source file's mtime.
 *
 * Weak because the bytes are a *build* of that source: two builds of one input
 * are interchangeable for caching without being byte-identical. Base36 keeps it
 * short, and truncation drops sub-millisecond noise that varies across
 * filesystems without distinguishing content.
 */
export function moveAssetETag(mtimeMs: number): string {
  return `W/"${Math.trunc(mtimeMs).toString(36)}"`;
}

export function moveAssetHeaders(contentType: string, etag: string): Record<string, string> {
  return { "Content-Type": contentType, "Cache-Control": "no-cache", "ETag": etag };
}

/**
 * True when the client's validator still matches, so the body can be skipped.
 *
 * A missing header is deliberately never a match: no validator means the client
 * is asking for the asset, not revalidating one it holds.
 */
export function moveAssetNotModified(ifNoneMatch: string | undefined | null, etag: string): boolean {
  return !!ifNoneMatch && ifNoneMatch === etag;
}
