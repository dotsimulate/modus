import { useState, useRef, useEffect, useCallback } from "react";
import { usePinboard } from "../providers/PinboardProvider";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";

type Props = {
  onOpenFile: (path: string) => void;
};

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

export function PinboardView({ onOpenFile }: Props) {
  const {
    groups, activeGroupId, activeGroup,
    setActiveGroup, addGroup, removeGroup, renameGroup,
    unpinFromActive,
  } = usePinboard();

  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const groupCtxMenu = useContextMenu();

  useEffect(() => {
    if (editingGroupId && renameRef.current) renameRef.current.focus();
  }, [editingGroupId]);

  const handleAddGroup = () => {
    addGroup("new group");
    // Will auto-switch to the new group
    setEditingGroupId(null); // reset any ongoing rename
    // Start rename inline after add
    setTimeout(() => {
      // Find the just-created group (last one) and kick off rename
      // We'll rely on state update — just trigger via the next render
    }, 0);
  };

  const startRename = (id: string, currentName: string) => {
    setEditingGroupId(id);
    setEditingName(currentName);
  };

  const commitRename = (id: string) => {
    if (editingName.trim()) renameGroup(id, editingName);
    setEditingGroupId(null);
  };

  const handleRenameKey = (id: string, e: React.KeyboardEvent) => {
    if (e.key === "Enter") commitRename(id);
    if (e.key === "Escape") setEditingGroupId(null);
  };

  const handleGroupContextMenu = useCallback((e: React.MouseEvent, groupId: string, groupName: string) => {
    const items: ContextMenuItem[] = [
      { kind: "action", label: "Rename", onClick: () => startRename(groupId, groupName) },
      {
        kind: "action",
        label: "Delete group",
        disabled: groups.length <= 1,
        onClick: () => removeGroup(groupId),
      },
      { kind: "separator" },
      { kind: "action", label: "New group", onClick: handleAddGroup },
    ];
    groupCtxMenu.open(e, items);
  }, [groups.length, removeGroup, groupCtxMenu]);

  return (
    <div className="pinboard">
      {/* Group tabs */}
      <div className="pinboard-groups">
        {groups.map((g) => (
          <div
            key={g.id}
            className={`pinboard-group${g.id === activeGroupId ? " pinboard-group--active" : ""}`}
            onClick={() => setActiveGroup(g.id)}
            onContextMenu={(e) => handleGroupContextMenu(e, g.id, g.name)}
          >
            {editingGroupId === g.id ? (
              <input
                ref={renameRef}
                className="pinboard-group-rename"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={() => commitRename(g.id)}
                onKeyDown={(e) => handleRenameKey(g.id, e)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span
                  className="pinboard-group-name"
                  onDoubleClick={(e) => { e.stopPropagation(); startRename(g.id, g.name); }}
                >
                  {g.name}
                </span>
                {g.paths.length > 0 && (
                  <span className="pinboard-group-count">{g.paths.length}</span>
                )}
                {groups.length > 1 && (
                  <button
                    className="pinboard-group-remove"
                    onClick={(e) => { e.stopPropagation(); removeGroup(g.id); }}
                    title="Remove group"
                  >
                    <svg width="6" height="6" viewBox="0 0 10 10" fill="none">
                      <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        <button className="pinboard-add-group" onClick={handleAddGroup} title="New group">
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* File list */}
      <div className="pinboard-files">
        {!activeGroup || activeGroup.paths.length === 0 ? (
          <div className="pinboard-empty">
            no pins
          </div>
        ) : (
          activeGroup.paths.map((path) => (
            <div key={path} className="pinboard-file" onClick={() => onOpenFile(path)}>
              <span className="pinboard-file-name">{basename(path)}</span>
              <span className="pinboard-file-path">{path}</span>
              <button
                className="pinboard-file-remove"
                onClick={(e) => { e.stopPropagation(); unpinFromActive(path); }}
                title="Unpin"
              >
                <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
      {groupCtxMenu.portal}
    </div>
  );
}
