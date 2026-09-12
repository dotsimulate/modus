import { describe, expect, test } from "bun:test";
import { stageMove, type ComposerMoveAttachment } from "../../ui/src/composer-move-attachments";
import { CreateSessionRequestSchema, SendMessageRequestSchema } from "../../session-schemas";

function attachment(name: string, inputs = {}): ComposerMoveAttachment {
  return { item: { name, label: name, description: "", mode: "inline", inputs: [] } as ComposerMoveAttachment["item"], inputs };
}

describe("multiple composer moves", () => {
  test("distinct selections stack and removing one preserves the other", () => {
    const first = attachment("first", { topic: "one" });
    const second = attachment("second", { topic: "two" });
    const selected = stageMove(stageMove([], first), second);
    expect(selected).toEqual([first, second]);
    expect(selected.filter((entry) => entry !== first)).toEqual([second]);
  });

  test("reselecting a move updates its inputs without losing another attachment", () => {
    const first = attachment("first");
    const second = attachment("second");
    const edited = attachment("first", { topic: "updated" });
    expect(stageMove([first, second], edited)).toEqual([edited, second]);
  });

  test("first and later messages carry both bindings, including without ordinary text", () => {
    const moves = [attachment("first"), attachment("second")].map(({ item, inputs }) => ({ name: item.name, inputs }));
    for (const prompt of ["ordinary input", " "]) {
      expect(CreateSessionRequestSchema.parse({ prompt, moves, skipProfileMoves: ["removed"] })).toEqual({ prompt, moves, skipProfileMoves: ["removed"] });
      expect(SendMessageRequestSchema.parse({ prompt, moves })).toEqual({ prompt, moves });
    }
  });
});
