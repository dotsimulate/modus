import type { TurnContent } from "../../../../sdk/index";
import type { ContextMenuItem } from "../ContextMenu";

/** Mid-turn: the reply being written has no closing event yet, so it cannot be branched. */
export function isSessionBusy(status: string): boolean {
  return status === "starting" || status === "running" || status === "interrupting";
}

/**
 * The seq that branches a whole conversation: its newest assistant turn. Both
 * history paths key an assistant turn on the seq of the event that closed it, so
 * a branch there carries the complete reply. A trailing prompt that never got a
 * reply is left out rather than copied without one.
 */
export function latestBranchSeq(turns: readonly Pick<TurnContent, "role" | "seq">[]): number | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.role === "assistant" && turn.seq > 0) return turn.seq;
  }
  return null;
}

export type SessionMenuOptions = {
  active: boolean;
  pinned: boolean;
  canBranch: boolean;
  onOpen: () => void;
  onRename: () => void;
  /** Omitted when the list offers no pinning. */
  onTogglePin?: () => void;
  onBranch: () => void;
  onCopyId: () => void;
  onArchive: () => void;
};

/** Right-click menu for a session row. */
export function buildSessionMenuItems(options: SessionMenuOptions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { kind: "action", label: "Open", disabled: options.active, onClick: options.onOpen },
    { kind: "action", label: "Rename", onClick: options.onRename },
  ];
  if (options.onTogglePin) {
    items.push({ kind: "action", label: options.pinned ? "Unpin" : "Pin", onClick: options.onTogglePin });
  }
  items.push(
    { kind: "action", label: "Branch...", disabled: !options.canBranch, onClick: options.onBranch },
    { kind: "separator" },
    { kind: "action", label: "Copy session ID", onClick: options.onCopyId },
    { kind: "separator" },
    { kind: "action", label: "Archive", onClick: options.onArchive },
  );
  return items;
}
