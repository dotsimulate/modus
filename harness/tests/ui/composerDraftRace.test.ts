import { describe, expect, it } from "bun:test";
import { shouldApplyFetchedDraft } from "../../ui/src/inputStore";

/**
 * The reported symptom: open a chat, start typing, and several seconds later the
 * text vanishes. The draft fetch resolves after the user has already typed and
 * overwrites the composer with the server's copy.
 */
describe("shouldApplyFetchedDraft", () => {
  it("seeds an untouched composer", () => {
    expect(shouldApplyFetchedDraft("")).toBe(true);
  });

  it("never overwrites text the user has already typed", () => {
    expect(shouldApplyFetchedDraft("half a sentence I was writing")).toBe(false);
  });

  it("treats whitespace as content rather than as empty", () => {
    // A trimmed check would discard a deliberate newline the user typed while
    // composing, which is the same class of loss with a smaller blast radius.
    expect(shouldApplyFetchedDraft("\n")).toBe(false);
    expect(shouldApplyFetchedDraft(" ")).toBe(false);
  });
});
