/** A single byte range; unsupported or malformed ranges are served in full. */
export type ByteRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

export function parseSingleByteRange(header: string | undefined, size: number): ByteRange {
  if (!header || header.length > 128 || !Number.isSafeInteger(size) || size < 0) {
    return { kind: "full" };
  }
  const value = header.trim();
  const explicit = /^bytes=(\d+)-(\d*)$/i.exec(value);
  const suffix = /^bytes=-(\d+)$/i.exec(value);
  if (!explicit && !suffix) return { kind: "full" };
  if (size === 0) return { kind: "unsatisfiable" };

  const length = BigInt(size);
  if (suffix) {
    const count = BigInt(suffix[1]!);
    if (count === 0n) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Number(count >= length ? 0n : length - count), end: size - 1 };
  }

  const first = BigInt(explicit![1]!);
  const last = explicit![2] ? BigInt(explicit![2]) : length - 1n;
  if (first >= length) return { kind: "unsatisfiable" };
  if (last < first) return { kind: "full" };
  return { kind: "partial", start: Number(first), end: Number(last >= length ? length - 1n : last) };
}

/** Preserve route-specific cache/security headers across 200, 206, and 416. */
export function serveRangedFile(file: ReturnType<typeof Bun.file>, rangeHeader: string | undefined, headers: Record<string, string>): Response {
  const size = file.size;
  const base = { ...headers, "Accept-Ranges": "bytes" };
  const range = parseSingleByteRange(rangeHeader, size);
  if (range.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...base, "Content-Length": "0", "Content-Range": `bytes */${size}` },
    });
  }
  if (range.kind === "partial") {
    return new Response(file.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...base,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }
  return new Response(file, { headers: { ...base, "Content-Length": String(size) } });
}
