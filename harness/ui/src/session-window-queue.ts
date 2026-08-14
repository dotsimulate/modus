import type { Attachment, MoveBinding } from "../../sdk/index";

export type SessionWindowQueuedMessage = {
  text: string;
  attachments: Attachment[];
  moves?: MoveBinding[];
};

export function createSessionWindowQueuedMessage(
  text: string,
  attachments: Attachment[],
  moves?: MoveBinding[],
): SessionWindowQueuedMessage {
  return { text, attachments, moves };
}

export function queuedSessionWindowMessageArgs(
  message: SessionWindowQueuedMessage,
): [string, Attachment[], MoveBinding[] | undefined] {
  return [message.text, message.attachments, message.moves];
}
