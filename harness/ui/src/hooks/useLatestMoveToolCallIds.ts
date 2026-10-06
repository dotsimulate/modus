import { useMemo, useState } from "react";
import type { Message } from "../../../sdk/index";
import { buildLatestMoveToolCallIds } from "../move-tool-view";

/** Text deltas must not invalidate every settled bubble and tool row. */
export function useLatestMoveToolCallIds(messages: Message[]): Map<string, string> {
  const [previous, setPrevious] = useState(() => buildLatestMoveToolCallIds(messages));
  const next = useMemo(() => buildLatestMoveToolCallIds(messages, previous), [messages, previous]);
  if (next !== previous) setPrevious(next);
  return next;
}
