import { useCallback, useEffect, useMemo, useState } from "react";
import type { MoveWidgetProps } from "../../../../harness/ui/src/components/MoveWidget";

const POLL_MS = 3500;
const RECENT_MESSAGE_LIMIT = 12;

type RoomSummary = {
  name: string;
  updated: string;
  members: number;
  messages: number;
};

type RoomMember = {
  displayName: string;
  sessionId: string;
  role?: string;
  notify: boolean;
};

type RoomMessage = {
  seq: number;
  author: string;
  sessionId?: string;
  timestamp: string;
  filename: string;
  content?: string;
};

type RoomDetail = {
  name: string;
  briefPath: string;
  brief: string;
  members: RoomMember[];
  messageCount: number;
  updated: string;
  messages: RoomMessage[];
};

type SessionOption = {
  id: string;
  preview: string;
  profile: string | null;
  status: string;
  lastMessageAt: number;
};

type SlotKey = "left" | "right";

type WorkbenchSlot = {
  key: SlotKey;
  label: string;
  sessionId: string | null;
  session?: SessionOption;
  member?: RoomMember;
};

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function fmtTime(value: string | number | undefined): string {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function defaultName(sessionId: string, session: SessionOption | undefined, role: string): string {
  return `${role}-${session?.profile ?? "agent"}-${shortId(sessionId)}`;
}

function readSessionKey(pageContext: MoveWidgetProps["pageContext"], key: string): string | null {
  const value = pageContext?.get(key);
  return typeof value === "string" && value.trim() ? value : null;
}

function compactText(text: string | undefined, max = 420): string {
  if (!text) return "";
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trim()}...` : trimmed;
}

function RoomPicker({
  rooms,
  selectedRoom,
  creating,
  busy,
  onSelect,
  onStartCreate,
  onCancelCreate,
  onCreate,
}: {
  rooms: RoomSummary[];
  selectedRoom: string | null;
  creating: boolean;
  busy: boolean;
  onSelect: (room: string) => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onCreate: (name: string, brief: string) => void;
}) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");

  if (creating) {
    return (
      <div className="room-console-block room-console-create">
        <input
          className="room-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="room-name"
          autoFocus
        />
        <textarea
          className="room-textarea room-textarea--brief"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="Brief / shared context"
          rows={4}
        />
        <div className="room-actions">
          <button
            className="room-primary"
            disabled={busy || !name.trim()}
            onClick={() => {
              onCreate(name, brief);
              setName("");
              setBrief("");
            }}
          >
            Create
          </button>
          <button className="room-secondary" onClick={onCancelCreate}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="room-console-top">
      <select
        className="room-select"
        value={selectedRoom ?? ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">Select room</option>
        {rooms.map((room) => (
          <option key={room.name} value={room.name}>
            {room.name} / {room.members} members / {room.messages} msgs
          </option>
        ))}
      </select>
      <button className="room-secondary" onClick={onStartCreate}>New</button>
    </div>
  );
}

function SlotCard({
  slot,
  busy,
  onAdd,
  onContext,
}: {
  slot: WorkbenchSlot;
  busy: boolean;
  onAdd: (slot: WorkbenchSlot) => void;
  onContext: (sessionId: string) => void;
}) {
  return (
    <div className={`room-slot-card room-slot-card--${slot.key}`}>
      <div className="room-slot-head">
        <span className="room-slot-title">{slot.label}</span>
        {slot.member && <span className="room-pill">in room</span>}
      </div>
      {slot.sessionId ? (
        <>
          <div className="room-slot-session">
            {slot.session?.profile ?? "agent"} / {shortId(slot.sessionId)}
          </div>
          <div className="room-slot-preview">{slot.session?.preview ?? "selected session"}</div>
          <div className="room-actions room-actions--tight">
            {!slot.member ? (
              <button className="room-primary" disabled={busy} onClick={() => onAdd(slot)}>Add</button>
            ) : (
              <button className="room-secondary" disabled={busy} onClick={() => onContext(slot.member!.sessionId)}>
                Context
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="room-slot-empty">No session selected</div>
      )}
    </div>
  );
}

function PairControls({
  slots,
  busy,
  onAdd,
  onContext,
}: {
  slots: WorkbenchSlot[];
  busy: boolean;
  onAdd: (slot: WorkbenchSlot) => void;
  onContext: (sessionId: string) => void;
}) {
  return (
    <div className="room-console-block">
      <div className="room-block-title">Workbench Pair</div>
      <div className="room-pair-grid">
        {slots.map((slot) => (
          <SlotCard
            key={slot.key}
            slot={slot}
            busy={busy}
            onAdd={onAdd}
            onContext={onContext}
          />
        ))}
      </div>
    </div>
  );
}

function RequestComposer({
  slots,
  memberCount,
  busy,
  onRequestAll,
  onRequestMany,
}: {
  slots: WorkbenchSlot[];
  memberCount: number;
  busy: boolean;
  onRequestAll: (prompt: string) => void;
  onRequestMany: (prompt: string, ids: string[]) => void;
}) {
  const [request, setRequest] = useState("");
  const memberSlots = slots.filter((slot) => slot.member);
  const left = slots.find((slot) => slot.key === "left" && slot.member);
  const right = slots.find((slot) => slot.key === "right" && slot.member);
  const canSend = !!request.trim() && !busy;

  const send = (ids?: string[]) => {
    const prompt = request.trim();
    if (!prompt) return;
    if (ids?.length) onRequestMany(prompt, ids);
    else onRequestAll(prompt);
    setRequest("");
  };

  return (
    <div className="room-console-block">
      <div className="room-block-title">Request</div>
      <textarea
        className="room-textarea"
        value={request}
        onChange={(event) => setRequest(event.target.value)}
        placeholder="Ask the selected agents to research, implement, review, summarize, or hand off through the room"
        rows={5}
      />
      <div className="room-request-grid">
        <button
          className="room-primary"
          disabled={!canSend || !left?.member}
          onClick={() => send([left!.member!.sessionId])}
        >
          Left
        </button>
        <button
          className="room-primary"
          disabled={!canSend || !right?.member}
          onClick={() => send([right!.member!.sessionId])}
        >
          Right
        </button>
        <button
          className="room-primary"
          disabled={!canSend || memberSlots.length === 0}
          onClick={() => send(memberSlots.map((slot) => slot.member!.sessionId))}
        >
          Pair
        </button>
        <button
          className="room-secondary"
          disabled={!canSend || memberCount === 0}
          onClick={() => send()}
        >
          All
        </button>
      </div>
    </div>
  );
}

function MembersStrip({
  room,
  busy,
  onToggleNotify,
  onRemove,
}: {
  room: RoomDetail;
  busy: boolean;
  onToggleNotify: (member: RoomMember) => void;
  onRemove: (member: RoomMember) => void;
}) {
  return (
    <details className="room-console-block room-details">
      <summary>
        <span className="room-block-title">Members</span>
        <span className="room-summary-meta">{room.members.length}</span>
      </summary>
      <div className="room-members-list">
        {room.members.length === 0 && <div className="room-empty">No members</div>}
        {room.members.map((member) => (
          <div key={member.sessionId} className="room-member-row">
            <div className="room-member-main">
              <span className="room-member-name">{member.displayName}</span>
              <span className="room-member-meta">
                {shortId(member.sessionId)}{member.role ? ` / ${member.role}` : ""}
              </span>
            </div>
            <button className="room-mini-btn" disabled={busy} onClick={() => onToggleNotify(member)}>
              {member.notify ? "notify" : "muted"}
            </button>
            <button className="room-mini-btn" disabled={busy} onClick={() => onRemove(member)}>remove</button>
          </div>
        ))}
      </div>
    </details>
  );
}

function ManualAdd({
  sessions,
  members,
  busy,
  onAdd,
}: {
  sessions: SessionOption[];
  members: RoomMember[];
  busy: boolean;
  onAdd: (sessionId: string, displayName: string, role: string, notify: boolean) => void;
}) {
  const [sessionId, setSessionId] = useState("");
  const [role, setRole] = useState("");
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const memberIds = useMemo(() => new Set(members.map((member) => member.sessionId)), [members]);
  const filtered = sessions.filter((session) => {
    if (memberIds.has(session.id)) return false;
    const query = filter.trim().toLowerCase();
    if (!query) return true;
    return [session.id, session.preview, session.profile ?? ""].some((value) => value.toLowerCase().includes(query));
  }).slice(0, 30);
  const selected = sessions.find((session) => session.id === sessionId);

  return (
    <details className="room-console-block room-details">
      <summary>
        <span className="room-block-title">Add Other Session</span>
      </summary>
      <div className="room-manual-add">
        <input
          className="room-input"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter sessions"
        />
        <select className="room-select" value={sessionId} onChange={(event) => {
          setSessionId(event.target.value);
          setName("");
        }}>
          <option value="">Select session</option>
          {filtered.map((session) => (
            <option key={session.id} value={session.id}>
              {session.profile ?? "agent"} / {shortId(session.id)} / {session.preview.slice(0, 48)}
            </option>
          ))}
        </select>
        <div className="room-two-col">
          <input
            className="room-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Display name"
          />
          <input
            className="room-input"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="Role"
          />
        </div>
        <button
          className="room-primary"
          disabled={busy || !sessionId}
          onClick={() => {
            onAdd(sessionId, name || defaultName(sessionId, selected, role || "member"), role, true);
            setSessionId("");
            setName("");
            setRole("");
          }}
        >
          Add And Send Context
        </button>
      </div>
    </details>
  );
}

function Thread({
  messages,
}: {
  messages: RoomMessage[];
}) {
  const recent = messages.slice(-RECENT_MESSAGE_LIMIT).reverse();
  return (
    <div className="room-console-block room-thread">
      <div className="room-block-title">Recent Thread</div>
      <div className="room-thread-list">
        {recent.length === 0 && <div className="room-empty">No room messages yet</div>}
        {recent.map((message) => (
          <article key={message.filename} className="room-message">
            <div className="room-message-head">
              <span className="room-message-author">{message.author}</span>
              <span className="room-message-meta">#{message.seq} / {fmtTime(message.timestamp)}</span>
            </div>
            {message.content && <pre className="room-message-body">{compactText(message.content)}</pre>}
          </article>
        ))}
      </div>
    </div>
  );
}

function UserNote({
  busy,
  onPost,
}: {
  busy: boolean;
  onPost: (content: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <details className="room-console-block room-details">
      <summary>
        <span className="room-block-title">Post User Note</span>
      </summary>
      <div className="room-note-box">
        <textarea
          className="room-textarea"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Write into the room as the user"
          rows={4}
        />
        <button
          className="room-primary"
          disabled={busy || !note.trim()}
          onClick={() => {
            onPost(note);
            setNote("");
          }}
        >
          Post
        </button>
      </div>
    </details>
  );
}

export default function RoomWidget({ callOp, pageContext }: MoveWidgetProps) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leftSessionId = readSessionKey(pageContext, "leftSessionId");
  const rightSessionId = readSessionKey(pageContext, "rightSessionId");

  const loadRooms = useCallback(async () => {
    const result = await callOp("list-rooms");
    if (!result.ok) {
      setError(result.error ?? "Failed to list rooms");
      return;
    }
    const parsed = parseJson<RoomSummary[]>(result.message, []);
    setRooms(parsed);
    if (!selectedRoom && parsed[0]) setSelectedRoom(parsed[0].name);
  }, [callOp, selectedRoom]);

  const loadSessions = useCallback(async () => {
    const result = await callOp("list-sessions", { limit: 80 });
    if (result.ok) setSessions(parseJson<SessionOption[]>(result.message, []));
  }, [callOp]);

  const loadDetail = useCallback(async (name: string) => {
    const result = await callOp("read-room", { room: name, includeContent: true });
    if (!result.ok) {
      setError(result.error ?? `Failed to read ${name}`);
      return;
    }
    setDetail(parseJson<RoomDetail | null>(result.message, null));
  }, [callOp]);

  const refresh = useCallback(async () => {
    setError(null);
    await Promise.all([loadRooms(), loadSessions()]);
    if (selectedRoom) await loadDetail(selectedRoom);
  }, [loadDetail, loadRooms, loadSessions, selectedRoom]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedRoom) void loadDetail(selectedRoom);
  }, [loadDetail, selectedRoom]);

  useEffect(() => {
    const id = setInterval(() => {
      if (selectedRoom) void loadDetail(selectedRoom);
      void loadRooms();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [loadDetail, loadRooms, selectedRoom]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const selectedDetail = selectedRoom && detail?.name === selectedRoom ? detail : null;
  const slots = useMemo<WorkbenchSlot[]>(() => {
    const makeSlot = (key: SlotKey, label: string, sessionId: string | null): WorkbenchSlot => ({
      key,
      label,
      sessionId,
      session: sessionId ? sessions.find((session) => session.id === sessionId) : undefined,
      member: sessionId && selectedDetail
        ? selectedDetail.members.find((member) => member.sessionId === sessionId)
        : undefined,
    });
    return [
      makeSlot("left", "Left", leftSessionId),
      makeSlot("right", "Right", rightSessionId),
    ];
  }, [leftSessionId, rightSessionId, selectedDetail, sessions]);

  const requireRoom = (): RoomDetail => {
    if (!selectedDetail) throw new Error("Select a room first");
    return selectedDetail;
  };

  const addMember = (sessionId: string, displayName: string, role: string, notify: boolean) => run(async () => {
    const room = requireRoom();
    const result = await callOp("add-member", {
      room: room.name,
      sessionId,
      displayName,
      role,
      notify,
      sendOnboarding: true,
    });
    if (!result.ok) throw new Error(result.error ?? "Add member failed");
  });

  const requestMany = (prompt: string, sessionIds: string[]) => run(async () => {
    const room = requireRoom();
    const uniqueIds = [...new Set(sessionIds)];
    const results = await Promise.all(uniqueIds.map((sessionId) => callOp("request", {
      room: room.name,
      prompt,
      sessionId,
    })));
    const failed = results.find((result) => !result.ok);
    if (failed) throw new Error(failed.error ?? "Request failed");
  });

  return (
    <div className="room-console">
      <header className="room-console-header">
        <div>
          <div className="room-console-title">Room</div>
          <div className="room-console-subtitle">
            {selectedDetail
              ? `${selectedDetail.members.length} members / ${selectedDetail.messageCount} messages`
              : "Select a shared room"}
          </div>
        </div>
        <button className="room-mini-btn" disabled={busy} onClick={() => void refresh()}>refresh</button>
      </header>

      {error && (
        <div className="room-error">
          <span>{error}</span>
          <button className="room-mini-btn" onClick={() => setError(null)}>clear</button>
        </div>
      )}

      <RoomPicker
        rooms={rooms}
        selectedRoom={selectedRoom}
        creating={creating}
        busy={busy}
        onSelect={(room) => {
          setCreating(false);
          setSelectedRoom(room || null);
        }}
        onStartCreate={() => setCreating(true)}
        onCancelCreate={() => setCreating(false)}
        onCreate={(name, brief) => run(async () => {
          const result = await callOp("create-room", { name, brief });
          if (!result.ok) throw new Error(result.error ?? "Create failed");
          const created = parseJson<RoomDetail | null>(result.message, null);
          setSelectedRoom(created?.name ?? name);
          setCreating(false);
        })}
      />

      {selectedDetail ? (
        <>
          <PairControls
            slots={slots}
            busy={busy}
            onAdd={(slot) => {
              if (!slot.sessionId) return;
              addMember(
                slot.sessionId,
                defaultName(slot.sessionId, slot.session, slot.key),
                slot.key,
                true,
              );
            }}
            onContext={(sessionId) => run(async () => {
              const result = await callOp("send-context", { room: selectedDetail.name, sessionId });
              if (!result.ok) throw new Error(result.error ?? "Context send failed");
            })}
          />

          <RequestComposer
            slots={slots}
            memberCount={selectedDetail.members.length}
            busy={busy}
            onRequestAll={(prompt) => run(async () => {
              const result = await callOp("request", { room: selectedDetail.name, prompt });
              if (!result.ok) throw new Error(result.error ?? "Request failed");
            })}
            onRequestMany={requestMany}
          />

          <Thread messages={selectedDetail.messages} />

          <MembersStrip
            room={selectedDetail}
            busy={busy}
            onToggleNotify={(member) => run(async () => {
              const result = await callOp("set-notify", {
                room: selectedDetail.name,
                sessionId: member.sessionId,
                notify: !member.notify,
              });
              if (!result.ok) throw new Error(result.error ?? "Notify update failed");
            })}
            onRemove={(member) => run(async () => {
              const result = await callOp("remove-member", {
                room: selectedDetail.name,
                sessionId: member.sessionId,
              });
              if (!result.ok) throw new Error(result.error ?? "Remove failed");
            })}
          />

          <ManualAdd
            sessions={sessions}
            members={selectedDetail.members}
            busy={busy}
            onAdd={addMember}
          />

          <UserNote
            busy={busy}
            onPost={(content) => run(async () => {
              const result = await callOp("post", { room: selectedDetail.name, author: "User", content });
              if (!result.ok) throw new Error(result.error ?? "Post failed");
            })}
          />
        </>
      ) : (
        <div className="room-console-empty">Create or select a room to coordinate the left and right sessions.</div>
      )}
    </div>
  );
}
