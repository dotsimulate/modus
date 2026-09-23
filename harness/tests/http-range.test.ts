import { describe, expect, test } from "bun:test";
import { parseSingleByteRange, serveRangedFile } from "../http-range";

const file = new Blob(["0123456789"]) as ReturnType<typeof Bun.file>;
const headers = { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

describe("single byte-range file responses", () => {
  test("serves a bounded range with matching body and metadata", async () => {
    const response = serveRangedFile(file, "bytes=2-5", headers);
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("2345");
  });

  test("clamps an open or oversized end and supports suffix ranges", async () => {
    for (const [range, expected] of [
      ["bytes=7-", "789"],
      ["bytes=7-999", "789"],
      ["bytes=-3", "789"],
      ["bytes=-999", "0123456789"],
    ]) {
      const response = serveRangedFile(file, range, headers);
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Length")).toBe(String(expected.length));
      expect(await response.text()).toBe(expected);
    }
  });

  test("rejects wholly unavailable ranges with the current size", async () => {
    for (const range of ["bytes=10-", "bytes=999-1000", "bytes=-0"]) {
      const response = serveRangedFile(file, range, headers);
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */10");
      expect(response.headers.get("Content-Length")).toBe("0");
      expect(await response.text()).toBe("");
    }
    expect(serveRangedFile(new Blob([]) as ReturnType<typeof Bun.file>, "bytes=0-", headers).status).toBe(416);
  });

  test("ignores malformed and unsupported ranges rather than emitting invalid 206 metadata", async () => {
    for (const range of ["bytes=9-2", "bytes=1-2junk", "bytes=0-1,4-5", "units=0-1"]) {
      const response = serveRangedFile(file, range, headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Range")).toBeNull();
      expect(response.headers.get("Content-Length")).toBe("10");
      expect(await response.text()).toBe("0123456789");
    }
  });

  test("does not lose numeric precision on oversized range bounds", () => {
    expect(parseSingleByteRange("bytes=999999999999999999999999999999-", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseSingleByteRange("bytes=1-999999999999999999999999999999", 10)).toEqual({ kind: "partial", start: 1, end: 9 });
  });
});
