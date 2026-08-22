import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { useSessionActions } from "../providers/SessionContext";
import { getSessionState } from "../sessionStore";
import { sessionActivityAt as activityAt } from "../sessionActivity";
import { useWidgetPollingValue } from "./widget-data";
import { useWidgetUiState } from "./ui-state";
import type { WidgetBase, WidgetProps } from "./types";
import type { ActiveSessionInfo, SessionInfo } from "../../../sdk/index";

type SessionStreamsConfig = WidgetBase & {
  type: "session-streams";
  limit?: number;
  focusTabOnSelect?: string;
};

type BucketDef = {
  id: string;
  title: string;
  parentId?: string | null;
};

type StreamDef = {
  id: string;
  title: string;
  buckets: BucketDef[];
};

type StreamsState = {
  streams: StreamDef[];
};

type LiveInfo = {
  status: string;
  preview: string;
  lastText: string | null;
};

const STREAM_PREFIX = "stream:";
const BUCKET_PREFIX = "bucket:";
const STREAM_PIN_PREFIX = "stream-pin:";
const BUCKET_PIN_PREFIX = "bucket-pin:";
const DRAG_MIME = "application/x-modus-session-id";

function parseTagList(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function displayTitle(s: SessionInfo): string {
  return s.title || s.last_prompt || s.preview || "new session";
}

function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `stream-${Date.now()}`;
}

function uniqueId(base: string, existing: Set<string>): string {
  let id = slugify(base);
  if (!existing.has(id)) return id;
  let i = 2;
  while (existing.has(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`;
  return `${Math.floor(diff / 604_800_000)}w`;
}

function scrollDuration(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return 8 + (((h >>> 0) % 700) / 100);
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}...`;
}

function statusLabel(status: string): string {
  if (status === "running") return "active";
  if (status === "starting" || status === "idle" || status === "paused") return "idle";
  if (status === "error") return "error";
  return "done";
}

function defaultState(activeCwd?: string): StreamsState {
  const title = activeCwd ? activeCwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "work" : "work";
  return {
    streams: [
      {
        id: slugify(title),
        title,
        buckets: [
          { id: uniqueId("main", new Set()), title: "main", parentId: null },
        ],
      },
    ],
  };
}

function normalizeState(raw: unknown, activeCwd?: string): StreamsState {
  if (!raw || typeof raw !== "object") return defaultState(activeCwd);
  const maybe = raw as Partial<StreamsState>;
  if (!Array.isArray(maybe.streams) || maybe.streams.length === 0) return defaultState(activeCwd);

  const streamIds = new Set<string>();
  const streams: StreamDef[] = [];
  for (const stream of maybe.streams) {
    if (!stream || typeof stream !== "object") continue;
    const src = stream as Partial<StreamDef>;
    const title = typeof src.title === "string" && src.title.trim() ? src.title.trim() : "stream";
    const id = typeof src.id === "string" && src.id.trim()
      ? uniqueId(src.id, streamIds)
      : uniqueId(title, streamIds);
    streamIds.add(id);

    const bucketIds = new Set<string>();
    const buckets: BucketDef[] = [];
    for (const bucket of Array.isArray(src.buckets) ? src.buckets : []) {
      if (!bucket || typeof bucket !== "object") continue;
      const b = bucket as Partial<BucketDef>;
      const bTitle = typeof b.title === "string" && b.title.trim() ? b.title.trim() : "bucket";
      const bId = typeof b.id === "string" && b.id.trim()
        ? uniqueId(b.id, bucketIds)
        : uniqueId(bTitle, bucketIds);
      bucketIds.add(bId);
      buckets.push({
        id: bId,
        title: bTitle,
        parentId: typeof b.parentId === "string" && b.parentId.trim() ? b.parentId : null,
      });
    }

    streams.push({ id, title, buckets });
  }

  return streams.length > 0 ? { streams } : defaultState(activeCwd);
}

function loadStreamsState(storageKey: string, activeCwd?: string): StreamsState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultState(activeCwd);
    return normalizeState(JSON.parse(raw), activeCwd);
  } catch {
    return defaultState(activeCwd);
  }
}

function sessionHasTag(s: SessionInfo, tag: string): boolean {
  return parseTagList(s.tags).includes(tag);
}

function sessionBucketId(s: SessionInfo, stream: StreamDef): string | null {
  const bucketIds = new Set(stream.buckets.map((b) => b.id));
  return parseTagList(s.tags)
    .find((tag) => tag.startsWith(BUCKET_PREFIX) && bucketIds.has(tag.slice(BUCKET_PREFIX.length)))
    ?.slice(BUCKET_PREFIX.length) ?? null;
}

function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => (
    displayTitle(s).toLowerCase().includes(q)
    || (s.profile ?? "").toLowerCase().includes(q)
    || (s.model ?? "").toLowerCase().includes(q)
    || parseTagList(s.tags).some((tag) => tag.includes(q))
  ));
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => activityAt(b) - activityAt(a));
}

export default function SessionStreamsWidget({ config, widgetId, onSelectSession, pageContext }: WidgetProps<SessionStreamsConfig>) {
  const { activeUserProfile, activeCwd } = useProfiles();
  const { refreshSessions, newSession } = useSessionActions();
  const userProfile = activeUserProfile ?? undefined;
  const limit = config.limit ?? 500;
  const storageKey = `harness:session-streams:${activeUserProfile ?? "anon"}:${activeCwd ?? "global"}`;

  const [state, setState] = useState<StreamsState>(() => loadStreamsState(storageKey, activeCwd));
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [selectedStreamId, setSelectedStreamId] = useWidgetUiState<string | null>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "selected-stream",
    state.streams[0]?.id ?? null,
  );

  useEffect(() => {
    setState(loadStreamsState(storageKey, activeCwd));
  }, [storageKey, activeCwd]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {}
  }, [state, storageKey]);

  const loadSessions = useCallback(async () => {
    const [recent, active] = await Promise.all([
      modus.listSessions({ limit, userProfile }),
      modus.getActiveSessions(userProfile),
    ]);
    return { recent, active };
  }, [limit, userProfile]);

  const { value, refresh } = useWidgetPollingValue<{ recent: SessionInfo[]; active: ActiveSessionInfo[] }>({
    load: loadSessions,
    scopeKey: `session-streams:${limit}:${userProfile ?? ""}`,
    intervalMs: 3500,
    initialValue: { recent: [], active: [] },
  });

  const liveMap = useMemo(() => {
    const map = new Map<string, LiveInfo>();
    for (const active of value.active) {
      map.set(active.id, {
        status: active.status,
        preview: active.preview,
        lastText: active.lastText,
      });
    }
    return map;
  }, [value.active]);

  const sessions = useMemo(() => value.recent.map((s) => {
    const local = getSessionState(s.id);
    const live = liveMap.get(s.id);
    return {
      ...s,
      status: local?.status ?? live?.status ?? s.status,
      preview: live?.preview ?? s.preview,
    };
  }), [value.recent, liveMap]);

  const stream = state.streams.find((s) => s.id === selectedStreamId) ?? state.streams[0];

  useEffect(() => {
    if (!stream && state.streams[0]) setSelectedStreamId(state.streams[0].id);
  }, [stream, state.streams, setSelectedStreamId]);

  const selectedSessionId = (
    (pageContext?.get("sessionId") as string | undefined)
    ?? (pageContext?.get("selectedSession") as string | undefined)
    ?? null
  );

  const streamMetrics = useMemo(() => {
    const map = new Map<string, {
      total: number;
      active: number;
      agents: string[];
      buckets: number;
    }>();
    for (const item of state.streams) {
      const tagged = sessions.filter((session) => sessionHasTag(session, `${STREAM_PREFIX}${item.id}`));
      const active = tagged.filter((session) => {
        const status = session.status;
        return status === "running" || status === "starting" || status === "paused";
      });
      const agents = Array.from(new Set(
        active.map((session) => session.profile || "default"),
      )).sort();
      map.set(item.id, {
        total: tagged.length,
        active: active.length,
        agents,
        buckets: item.buckets.length,
      });
    }
    return map;
  }, [sessions, state.streams]);

  const selectSession = useCallback((id: string) => {
    if (pageContext) {
      pageContext.emit({ type: "select-session", sessionId: id });
      if (config.focusTabOnSelect) {
        pageContext.emit({ type: "focus-tab", tabId: config.focusTabOnSelect });
      }
    } else {
      onSelectSession(id);
    }
  }, [config.focusTabOnSelect, onSelectSession, pageContext]);

  const mutateSessionTags = useCallback(async (sessionId: string, remove: string[], add: string[]) => {
    for (const tag of remove) {
      await modus.removeTag(sessionId, tag).catch(() => {});
    }
    for (const tag of add) {
      await modus.addTag(sessionId, tag).catch(() => {});
    }
    await Promise.all([refresh(), refreshSessions()]);
  }, [refresh, refreshSessions]);

  const assignSession = useCallback(async (sessionId: string, targetStream: StreamDef, bucketId: string | null) => {
    const session = sessions.find((s) => s.id === sessionId);
    const tags = parseTagList(session?.tags);
    const remove = tags.filter((tag) => (
      tag.startsWith(STREAM_PREFIX)
      || tag.startsWith(BUCKET_PREFIX)
      || tag.startsWith(STREAM_PIN_PREFIX)
      || tag.startsWith(BUCKET_PIN_PREFIX)
    ));
    const add = [`${STREAM_PREFIX}${targetStream.id}`];
    if (bucketId) add.push(`${BUCKET_PREFIX}${bucketId}`);
    await mutateSessionTags(sessionId, remove, add);
  }, [mutateSessionTags, sessions]);

  const removeFromStream = useCallback(async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    const remove = parseTagList(session?.tags).filter((tag) => (
      tag.startsWith(STREAM_PREFIX)
      || tag.startsWith(BUCKET_PREFIX)
      || tag.startsWith(STREAM_PIN_PREFIX)
      || tag.startsWith(BUCKET_PIN_PREFIX)
    ));
    await mutateSessionTags(sessionId, remove, []);
  }, [mutateSessionTags, sessions]);

  const pinSession = useCallback(async (sessionId: string, pinTag: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    const tags = parseTagList(session?.tags);
    if (tags.includes(pinTag)) {
      await mutateSessionTags(sessionId, [pinTag], []);
    } else {
      await mutateSessionTags(sessionId, [], [pinTag]);
    }
  }, [mutateSessionTags, sessions]);

  const handleDrop = useCallback(async (e: DragEvent, bucketId: string | null) => {
    e.preventDefault();
    setDragOver(null);
    if (!stream) return;
    const id = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (!id) return;
    await assignSession(id, stream, bucketId);
  }, [assignSession, stream]);

  const addStream = useCallback(() => {
    const title = window.prompt("Stream name");
    if (!title?.trim()) return;
    setState((prev) => {
      const ids = new Set(prev.streams.map((s) => s.id));
      const id = uniqueId(title, ids);
      setSelectedStreamId(id);
      return {
        streams: [...prev.streams, { id, title: title.trim(), buckets: [] }],
      };
    });
  }, [setSelectedStreamId]);

  const addBucket = useCallback((parentId: string | null = null) => {
    if (!stream) return;
    const title = window.prompt(parentId ? "Nested bucket name" : "Bucket name");
    if (!title?.trim()) return;
    setState((prev) => ({
      streams: prev.streams.map((s) => {
        if (s.id !== stream.id) return s;
        const ids = new Set(s.buckets.map((b) => b.id));
        return {
          ...s,
          buckets: [...s.buckets, { id: uniqueId(title, ids), title: title.trim(), parentId }],
        };
      }),
    }));
  }, [stream]);

  const addSelectedToStream = useCallback(async () => {
    if (!selectedSessionId || !stream) return;
    await assignSession(selectedSessionId, stream, null);
  }, [assignSession, selectedSessionId, stream]);

  const createSessionInBucket = useCallback(async (bucketId: string | null) => {
    if (!stream) return;
    const id = await newSession();
    if (!id) return;
    await assignSession(id, stream, bucketId);
    selectSession(id);
  }, [assignSession, newSession, selectSession, stream]);

  if (!stream) {
    return (
      <div className="ssw">
        <button className="ssw-primary" onClick={addStream}>+ stream</button>
      </div>
    );
  }

  const streamTag = `${STREAM_PREFIX}${stream.id}`;
  const currentStreamSessions = sortSessions(filterSessions(
    sessions.filter((s) => sessionHasTag(s, streamTag)),
    search,
  ));
  const currentStreamIds = new Set(currentStreamSessions.map((s) => s.id));
  const outsideSessions = sortSessions(filterSessions(
    sessions.filter((s) => !currentStreamIds.has(s.id)),
    search,
  )).slice(0, search.trim() ? 40 : 12);
  const rootSessions = currentStreamSessions.filter((s) => sessionBucketId(s, stream) == null);
  const streamPinned = rootSessions.filter((s) => sessionHasTag(s, `${STREAM_PIN_PREFIX}${stream.id}`));
  const streamUnpinned = rootSessions.filter((s) => !sessionHasTag(s, `${STREAM_PIN_PREFIX}${stream.id}`));

  return (
    <div className="ssw">
      <div className="ssw-header">
        <div className="ssw-stream-panels">
          {state.streams.map((item) => (
            <button
              key={item.id}
              className={`ssw-stream-card ssw-drop${item.id === stream.id ? " active" : ""}${dragOver === `stream-card:${item.id}` ? " drag-over" : ""}`}
              onClick={() => setSelectedStreamId(item.id)}
              onDragOver={(e) => { e.preventDefault(); setDragOver(`stream-card:${item.id}`); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain");
                if (id) await assignSession(id, item, null);
              }}
              title={item.title}
            >
              <span className="ssw-stream-card-title">{item.title}</span>
              <span className="ssw-stream-card-stats">
                <span>{streamMetrics.get(item.id)?.active ?? 0} active</span>
                <span>{streamMetrics.get(item.id)?.agents.length ?? 0} agents</span>
              </span>
              <span className="ssw-stream-card-meta">
                {streamMetrics.get(item.id)?.total ?? 0} sessions
              </span>
            </button>
          ))}
        </div>
        <div className="ssw-focus">
          <div className="ssw-focus-main">
            <div className="ssw-focus-title">{stream.title}</div>
            <div className="ssw-focus-metrics">
              <span>{streamMetrics.get(stream.id)?.active ?? 0} active</span>
              <span>{streamMetrics.get(stream.id)?.agents.length ?? 0} agents</span>
              <span>{streamMetrics.get(stream.id)?.total ?? 0} sessions</span>
              <span>{streamMetrics.get(stream.id)?.buckets ?? 0} buckets</span>
            </div>
            <div className="ssw-focus-agents">
              {(streamMetrics.get(stream.id)?.agents.length ?? 0) > 0
                ? streamMetrics.get(stream.id)!.agents.join(" / ")
                : "no active agents"}
            </div>
          </div>
          <div className="ssw-actions">
            <button className="ssw-primary" onClick={() => createSessionInBucket(null)}>+ session</button>
            <button className="ssw-secondary" onClick={() => addBucket(null)}>+ bucket</button>
            <button className="ssw-secondary" onClick={addStream}>+ stream</button>
            {selectedSessionId && (
              <button className="ssw-secondary" onClick={addSelectedToStream}>add selected</button>
            )}
          </div>
        </div>
      </div>

      <div className="ssw-body">
        <div className="ssw-list-tools">
          <input
            className="ssw-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search sessions..."
          />
        </div>
        <section
          className={`ssw-section ssw-drop${dragOver === `stream:${stream.id}` ? " drag-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(`stream:${stream.id}`); }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => handleDrop(e, null)}
        >
          <div className="ssw-section-head">
            <span className="ssw-section-title">{stream.title}</span>
            <span className="ssw-section-count">{rootSessions.length}</span>
          </div>
          <div className="ssw-rows">
            {[...streamPinned, ...streamUnpinned].map((session) => (
              <StreamSessionRow
                key={session.id}
                session={session}
                liveInfo={liveMap.get(session.id)}
                selected={session.id === selectedSessionId}
                pinTag={`${STREAM_PIN_PREFIX}${stream.id}`}
                onSelect={selectSession}
                onPin={pinSession}
                onRemove={removeFromStream}
              />
            ))}
          </div>
        </section>

        <div className="ssw-buckets">
          {stream.buckets.filter((bucket) => !bucket.parentId).map((bucket) => (
            <BucketSection
              key={bucket.id}
              bucket={bucket}
              stream={stream}
              sessions={currentStreamSessions}
              liveMap={liveMap}
              selectedSessionId={selectedSessionId}
              dragOver={dragOver}
              depth={0}
              onDrop={handleDrop}
              onDragOver={setDragOver}
              onSelect={selectSession}
              onPin={pinSession}
              onRemove={removeFromStream}
              onAddBucket={addBucket}
              onNewSession={createSessionInBucket}
            />
          ))}
        </div>

        {(outsideSessions.length > 0 || search.trim()) && (
          <section className="ssw-section ssw-section--pool">
            <div className="ssw-section-head">
              <span className="ssw-section-title">recent</span>
              <span className="ssw-section-count">{outsideSessions.length}</span>
            </div>
            <div className="ssw-rows">
              {outsideSessions.map((session) => (
                <StreamSessionRow
                  key={session.id}
                  session={session}
                  liveInfo={liveMap.get(session.id)}
                  selected={session.id === selectedSessionId}
                  onSelect={selectSession}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function BucketSection({
  bucket,
  stream,
  sessions,
  liveMap,
  selectedSessionId,
  dragOver,
  depth,
  onDrop,
  onDragOver,
  onSelect,
  onPin,
  onRemove,
  onAddBucket,
  onNewSession,
}: {
  bucket: BucketDef;
  stream: StreamDef;
  sessions: SessionInfo[];
  liveMap: Map<string, LiveInfo>;
  selectedSessionId: string | null;
  dragOver: string | null;
  depth: number;
  onDrop: (e: DragEvent, bucketId: string | null) => void;
  onDragOver: (key: string | null) => void;
  onSelect: (id: string) => void;
  onPin: (id: string, pinTag: string) => void;
  onRemove: (id: string) => void;
  onAddBucket: (parentId: string | null) => void;
  onNewSession: (bucketId: string | null) => void;
}) {
  const children = stream.buckets.filter((b) => b.parentId === bucket.id);
  const bucketSessions = sessions.filter((s) => sessionBucketId(s, stream) === bucket.id);
  const pinTag = `${BUCKET_PIN_PREFIX}${bucket.id}`;
  const pinned = bucketSessions.filter((s) => sessionHasTag(s, pinTag));
  const unpinned = bucketSessions.filter((s) => !sessionHasTag(s, pinTag));
  const dropKey = `bucket:${bucket.id}`;

  return (
    <section
      className={`ssw-section ssw-bucket ssw-drop${dragOver === dropKey ? " drag-over" : ""}`}
      style={{ "--bucket-depth": depth } as CSSProperties}
      onDragOver={(e) => { e.preventDefault(); onDragOver(dropKey); }}
      onDragLeave={() => onDragOver(null)}
      onDrop={(e) => onDrop(e, bucket.id)}
    >
      <div className="ssw-section-head">
        <span className="ssw-section-title">{bucket.title}</span>
        <span className="ssw-section-count">{bucketSessions.length}</span>
        <button className="ssw-mini-btn" onClick={() => onNewSession(bucket.id)} title="New session">+</button>
        <button className="ssw-mini-btn" onClick={() => onAddBucket(bucket.id)} title="Nested bucket">b</button>
      </div>
      <div className="ssw-rows">
        {[...pinned, ...unpinned].map((session) => (
          <StreamSessionRow
            key={session.id}
            session={session}
            liveInfo={liveMap.get(session.id)}
            selected={session.id === selectedSessionId}
            pinTag={pinTag}
            onSelect={onSelect}
            onPin={onPin}
            onRemove={onRemove}
          />
        ))}
      </div>
      {children.map((child) => (
        <BucketSection
          key={child.id}
          bucket={child}
          stream={stream}
          sessions={sessions}
          liveMap={liveMap}
          selectedSessionId={selectedSessionId}
          dragOver={dragOver}
          depth={depth + 1}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onSelect={onSelect}
          onPin={onPin}
          onRemove={onRemove}
          onAddBucket={onAddBucket}
          onNewSession={onNewSession}
        />
      ))}
    </section>
  );
}

function StreamSessionRow({
  session,
  liveInfo,
  selected,
  pinTag,
  onSelect,
  onPin,
  onRemove,
}: {
  session: SessionInfo;
  liveInfo?: LiveInfo;
  selected: boolean;
  pinTag?: string;
  onSelect: (id: string) => void;
  onPin?: (id: string, pinTag: string) => void;
  onRemove?: (id: string) => void;
}) {
  const tags = parseTagList(session.tags);
  const pinned = !!pinTag && tags.includes(pinTag);
  const status = liveInfo?.status ?? session.status;
  const liveText = status === "running"
    ? truncateText(liveInfo?.lastText || liveInfo?.preview || session.preview || session.last_prompt || "", 90) || null
    : null;
  const lastLiveRef = useRef<string | null>(null);
  if (liveText) lastLiveRef.current = liveText;
  const displayLive = liveText ?? lastLiveRef.current;

  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_MIME, session.id);
    e.dataTransfer.setData("text/plain", session.id);
  };

  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      className={`ssw-row${selected ? " selected" : ""}${status === "running" ? " running" : ""}`}
      draggable
      onDragStart={handleDragStart}
      onClick={() => onSelect(session.id)}
    >
      <span className={`ssw-dot ssw-dot--${statusLabel(status)}`} />
      <div className="ssw-row-content">
        <div className="ssw-row-title">{displayTitle(session)}</div>
        <div className="ssw-row-meta">
          {session.profile && <span>{session.profile}</span>}
          <span>{relativeTime(activityAt(session))}</span>
          {session.message_count > 0 && <span>{session.message_count}</span>}
        </div>
        <div className={`ssw-row-live-wrap${liveText ? " active" : ""}`}>
          <div className="ssw-row-live">
            {displayLive && (
              <span style={{ animationDuration: `${scrollDuration(session.id)}s` }}>
                {displayLive} - {displayLive} - {displayLive} -
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="ssw-row-actions">
        {pinTag && onPin && (
          <button
            className={`ssw-row-action${pinned ? " active" : ""}`}
            onClick={(e) => { stop(e); onPin(session.id, pinTag); }}
            title={pinned ? "Unpin here" : "Pin here"}
          >
            p
          </button>
        )}
        {onRemove && (
          <button
            className="ssw-row-action"
            onClick={(e) => { stop(e); onRemove(session.id); }}
            title="Remove from stream"
          >
            x
          </button>
        )}
      </div>
    </div>
  );
}
