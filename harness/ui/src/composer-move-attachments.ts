import type { MoveListItem } from "../../sdk/index";

export type ComposerMoveAttachment = {
  item: MoveListItem;
  inputs: Record<string, unknown>;
  apiToken?: string;
  instanceId?: string;
};

/** Picking the same move edits its inputs; distinct moves keep their order. */
export function stageMove(
  attachments: ComposerMoveAttachment[],
  attachment: ComposerMoveAttachment,
): ComposerMoveAttachment[] {
  const index = attachments.findIndex((entry) => entry.item.name === attachment.item.name);
  if (index < 0) return [...attachments, attachment];
  return attachments.map((entry, i) => i === index ? attachment : entry);
}
