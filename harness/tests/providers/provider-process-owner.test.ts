import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ProviderProcessOwner } from "../../providers/provider-process-owner";

describe("ProviderProcessOwner", () => {
  test("refuses a replacement until the current process generation closes", () => {
    const owner = new ProviderProcessOwner<object>();
    const first = owner.claim({ name: "first" });

    expect(() => owner.claim({ name: "replacement" })).toThrow("before generation 1 closed");
    expect(owner.current()).toBe(first);

    expect(owner.release(first)).toBe(true);
    const replacement = owner.claim({ name: "replacement" });
    expect(replacement.generation).toBe(2);
  });

  test("late cleanup from an old generation cannot release its replacement", () => {
    const owner = new ProviderProcessOwner<object>();
    const first = owner.claim({ name: "first" });
    owner.release(first);
    const replacement = owner.claim({ name: "replacement" });

    expect(owner.release(first)).toBe(false);
    expect(owner.current()).toBe(replacement);
  });

  test("an exit event cannot unlock replacement spawning before close", () => {
    const owner = new ProviderProcessOwner<object>();
    const events = new EventEmitter();
    const first = owner.claim({ name: "first" });
    let released = false;
    owner.releaseOnClose(first, events, () => { released = true; });

    events.emit("exit", 0);
    expect(released).toBe(false);
    expect(() => owner.claim({ name: "too-early" })).toThrow("before generation 1 closed");

    events.emit("close", 0);
    expect(released).toBe(true);
    expect(owner.claim({ name: "replacement" }).generation).toBe(2);
  });
});
