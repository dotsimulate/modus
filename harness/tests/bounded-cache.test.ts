import { describe, expect, test } from "bun:test";
import { BoundedCache } from "../bounded-cache";

describe("bounded cache", () => {
  test("evicts by retained weight and recent use rather than insertion alone", () => {
    const cache = new BoundedCache<string, string>(3, 10);
    cache.set("a", "A", 4);
    cache.set("b", "B", 4);
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C", 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.weight).toBe(8);
    expect(cache.size).toBe(2);
  });

  test("bounds tiny entries, replacements, and oversized values", () => {
    const cache = new BoundedCache<number, string>(2, 10);
    cache.set(1, "old", 2);
    cache.set(2, "two", 2);
    cache.set(1, "replacement", 8);
    expect(cache.weight).toBe(10);
    cache.set(3, "three", 1);
    expect(cache.get(2)).toBeUndefined();
    cache.set(1, "too large", 11);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.weight).toBe(1);
    for (let i = 0; i < 1000; i++) cache.set(i, "empty", 0);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.weight).toBe(0);
    expect(cache.size).toBe(0);
  });
});
