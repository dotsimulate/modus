import { describe, expect, test } from "bun:test";
import { moveAssetETag, moveAssetHeaders, moveAssetNotModified } from "../move-asset-cache";

describe("moveAssetETag", () => {
  test("changes when the source mtime changes", () => {
    expect(moveAssetETag(1_700_000_000_000)).not.toBe(moveAssetETag(1_700_000_000_001));
  });

  test("is stable for the same mtime", () => {
    expect(moveAssetETag(1_700_000_000_000)).toBe(moveAssetETag(1_700_000_000_000));
  });

  test("ignores sub-millisecond noise, which varies by filesystem without meaning a rebuild", () => {
    expect(moveAssetETag(1_700_000_000_000.7)).toBe(moveAssetETag(1_700_000_000_000));
  });

  test("is a quoted weak validator, because the body is a build of the source", () => {
    expect(moveAssetETag(1_700_000_000_000)).toMatch(/^W\/"[a-z0-9]+"$/);
  });
});

describe("moveAssetHeaders", () => {
  test("tells the browser to revalidate rather than reuse blindly", () => {
    // The regression this guards: with no Cache-Control a client may reuse a
    // widget bundle indefinitely and never observe an authored edit.
    expect(moveAssetHeaders("application/javascript", 'W/"abc"')["Cache-Control"]).toBe("no-cache");
  });

  test("carries the validator and the content type", () => {
    expect(moveAssetHeaders("text/css", 'W/"abc"')).toEqual({
      "Content-Type": "text/css",
      "Cache-Control": "no-cache",
      "ETag": 'W/"abc"',
    });
  });
});

describe("moveAssetNotModified", () => {
  test("matches when the client still holds the current validator", () => {
    expect(moveAssetNotModified('W/"abc"', 'W/"abc"')).toBe(true);
  });

  test("rejects a stale validator, so an edited widget is always re-sent", () => {
    expect(moveAssetNotModified('W/"old"', 'W/"new"')).toBe(false);
  });

  test("rejects a missing validator rather than treating absence as a match", () => {
    // A first load sends no If-None-Match. Answering 304 there returns an empty
    // body the client has no cached copy for, and the widget never renders.
    expect(moveAssetNotModified(undefined, 'W/"abc"')).toBe(false);
    expect(moveAssetNotModified(null, 'W/"abc"')).toBe(false);
    expect(moveAssetNotModified("", 'W/"abc"')).toBe(false);
  });
});
