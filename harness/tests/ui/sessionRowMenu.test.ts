import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextMenuItem } from "../../ui/src/components/ContextMenu";
import {
  buildSessionMenuItems,
  isSessionBusy,
  latestBranchSeq,
  type SessionMenuOptions,
} from "../../ui/src/components/sidebar/sessionMenu";

function options(overrides: Partial<SessionMenuOptions> = {}): SessionMenuOptions {
  return {
    active: false,
    pinned: false,
    canBranch: true,
    onOpen: mock(() => {}),
    onRename: mock(() => {}),
    onTogglePin: mock(() => {}),
    onBranch: mock(() => {}),
    onCopyId: mock(() => {}),
    onArchive: mock(() => {}),
    ...overrides,
  };
}

const labels = (items: ContextMenuItem[]) => items.map((item) => item.kind === "separator" ? "---" : item.label);
const action = (items: ContextMenuItem[], label: string) => {
  const item = items.find((entry) => entry.kind === "action" && entry.label === label);
  if (!item || item.kind !== "action") throw new Error(`no ${label} item`);
  return item;
};

describe("session row menu", () => {
  test("offers the row actions in order", () => {
    expect(labels(buildSessionMenuItems(options()))).toEqual([
      "Open", "Rename", "Pin", "Branch...", "---", "Copy session ID", "---", "Archive",
    ]);
  });

  test("names the pin action by current state, and drops it where pinning is not offered", () => {
    expect(labels(buildSessionMenuItems(options({ pinned: true })))).toContain("Unpin");
    expect(labels(buildSessionMenuItems(options({ onTogglePin: undefined })))).not.toContain("Pin");
  });

  test("disables Open on the active row and Branch when there is nothing to branch", () => {
    const items = buildSessionMenuItems(options({ active: true, canBranch: false }));
    expect(action(items, "Open").disabled).toBe(true);
    expect(action(items, "Branch...").disabled).toBe(true);
    expect(action(items, "Rename").disabled).toBeFalsy();
  });

  test("each item runs its own callback", () => {
    const opts = options();
    const items = buildSessionMenuItems(opts);
    const pairs: [string, () => void][] = [
      ["Open", opts.onOpen], ["Rename", opts.onRename], ["Pin", opts.onTogglePin!],
      ["Branch...", opts.onBranch], ["Copy session ID", opts.onCopyId], ["Archive", opts.onArchive],
    ];
    for (const [label, callback] of pairs) {
      action(items, label).onClick();
      expect(callback).toHaveBeenCalledTimes(1);
    }
  });
});

describe("whole-session branch point", () => {
  test("is the newest assistant turn", () => {
    expect(latestBranchSeq([
      { role: "user", seq: 1 }, { role: "assistant", seq: 4 },
      { role: "user", seq: 5 }, { role: "assistant", seq: 9 },
    ])).toBe(9);
  });

  test("skips a trailing prompt that never got a reply", () => {
    expect(latestBranchSeq([
      { role: "user", seq: 1 }, { role: "assistant", seq: 4 }, { role: "user", seq: 5 }, { role: "system", seq: 6 },
    ])).toBe(4);
  });

  test("is absent when no reply exists", () => {
    expect(latestBranchSeq([])).toBeNull();
    expect(latestBranchSeq([{ role: "user", seq: 1 }])).toBeNull();
    expect(latestBranchSeq([{ role: "assistant", seq: 0 }])).toBeNull();
  });

  test("is unavailable mid-turn", () => {
    for (const status of ["starting", "running", "interrupting"]) expect(isSessionBusy(status)).toBe(true);
    for (const status of ["idle", "paused", "done", "error"]) expect(isSessionBusy(status)).toBe(false);
  });
});

// Portal events bubble through the React tree, so a menu or dialog rendered inside
// the row would hand every click to the row's onClick and open the session.
test("the row menu and branch dialog render beside the row, not inside it", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "ui", "src", "components", "sidebar", "SessionItem.tsx"), "utf8");
  expect(src).toContain("onContextMenu={openMenu}");
  // The row is the outermost element, so its closing tag is the file's last one.
  const rowEnd = src.lastIndexOf("</div>");
  expect(src.indexOf("{ctxMenu.portal}")).toBeGreaterThan(rowEnd);
  expect(src.indexOf("{branch && createPortal(")).toBeGreaterThan(rowEnd);
});
