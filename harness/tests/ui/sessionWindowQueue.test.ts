import { describe, expect, test } from "bun:test";
import type { Attachment, MoveBinding } from "../../sdk/index";
import {
  createSessionWindowQueuedMessage,
  queuedSessionWindowMessageArgs,
} from "../../ui/src/session-window-queue";

describe("SessionWindow queued messages", () => {
  test("preserves move bindings until the queued prompt is flushed", () => {
    const attachments: Attachment[] = [{
      type: "file",
      mediaType: "text/plain",
      data: "queued attachment",
      name: "note.txt",
    }];
    const moves: MoveBinding[] = [{ name: "review", inputs: { depth: "full" } }];

    const queued = createSessionWindowQueuedMessage("queued prompt", attachments, moves);

    expect(queuedSessionWindowMessageArgs(queued)).toEqual([
      "queued prompt",
      attachments,
      moves,
    ]);
  });
});
