import { useState, useEffect, useRef, useCallback } from "react";
import type { MoveWidgetProps } from "../../../../harness/ui/src/components/MoveWidget";

const POLL_MS = 2000;

// ── Types ──

interface MemberConfig {
  name: string;
  profile: string;
  stance: string;
  isJudge: boolean;
}

interface CouncilMessage {
  name: string;
  role: string;
  content: string;
  round: number;
  timestamp: string;
}

interface CouncilState {
  topic: string;
  roundLimit: number;
  responseLength: string;
  members: (MemberConfig & { sessionId: string })[];
  messages: CouncilMessage[];
  currentRound: number;
  turnIndex: number;
  status: "setup" | "initializing" | "active" | "judging" | "complete";
}

// ── Constants ──

const PROFILES = [
  "default", "dev-agent", "research", "summarizer",
  "thought-spew-protocol", "bug-fixer", "git-ops",
  "doc-maintainer", "web-browser", "web-inspector",
  "mission-formulator",
];

const STANCES = [
  { value: "none", label: "None (pass-through)" },
  { value: "advocate", label: "Advocate" },
  { value: "skeptic", label: "Skeptic" },
  { value: "synthesizer", label: "Synthesizer" },
  { value: "devils_advocate", label: "Devil's Advocate" },
  { value: "pragmatist", label: "Pragmatist" },
  { value: "visionary", label: "Visionary" },
  { value: "challenger", label: "Challenger" },
  { value: "reframer", label: "Reframer" },
  { value: "traditionalist", label: "Traditionalist" },
  { value: "mediator", label: "Mediator" },
];

const RESPONSE_LENGTHS = [
  { value: "rapid", label: "Rapid (1-2 sentences)" },
  { value: "short", label: "Short (1 paragraph)" },
  { value: "medium", label: "Medium (2-3 paragraphs)" },
  { value: "long", label: "Long (3-5 paragraphs)" },
];

const stanceColors: Record<string, string> = {
  none: "#888",
  advocate: "#4ade80",
  skeptic: "#f87171",
  synthesizer: "#60a5fa",
  devils_advocate: "#c084fc",
  pragmatist: "#fb923c",
  visionary: "#f0abfc",
  challenger: "#ff6b6b",
  reframer: "#67e8f9",
  traditionalist: "#d4a574",
  mediator: "#86efac",
  moderator: "#fbbf24",
  judge: "#e2e8f0",
};

function memberColor(m: MemberConfig): string {
  if (m.isJudge) return stanceColors.judge;
  return stanceColors[m.stance] || stanceColors.none;
}

// ── Default members ──

let nameCounter = 0;
function nextName(): string {
  const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"];
  return names[nameCounter++ % names.length];
}

function defaultMember(): MemberConfig {
  return { name: nextName(), profile: "default", stance: "none", isJudge: false };
}

// ── Setup Screen ──

function SetupScreen({ onStart, onShowHistory }: { onStart: (config: {
  topic: string;
  roundLimit: number;
  responseLength: string;
  members: MemberConfig[];
}) => void; onShowHistory?: () => void }) {
  const [topic, setTopic] = useState("");
  const [rounds, setRounds] = useState(2);
  const [responseLength, setResponseLength] = useState("medium");
  const [members, setMembers] = useState<MemberConfig[]>(() => {
    nameCounter = 0;
    return [defaultMember(), defaultMember()];
  });
  const [hasJudge, setHasJudge] = useState(false);

  const canStart = topic.trim().length > 0 && members.length >= 2;

  const updateMember = (idx: number, updates: Partial<MemberConfig>) => {
    setMembers(prev => prev.map((m, i) => i === idx ? { ...m, ...updates } : m));
  };

  const addMember = () => {
    setMembers(prev => [...prev, defaultMember()]);
  };

  const removeMember = (idx: number) => {
    if (members.length <= 2) return;
    setMembers(prev => prev.filter((_, i) => i !== idx));
  };

  const toggleJudge = () => {
    setHasJudge(prev => {
      const next = !prev;
      if (next) {
        setMembers(prev => [...prev, { name: "Judge", profile: "default", stance: "none", isJudge: true }]);
      } else {
        setMembers(prev => {
          const filtered = prev.filter(m => !m.isJudge);
          return filtered.length >= 2 ? filtered : filtered;
        });
      }
      return next;
    });
  };

  return (
    <div className="council">
      <div className="council-header">
        <span className="council-title">Configure Council</span>
        {onShowHistory && (
          <button className="council-btn-ghost" onClick={onShowHistory}>history</button>
        )}
      </div>

      <div className="council-body council-body--padded">
        {/* Topic */}
        <div className="council-field">
          <label className="council-label">Topic</label>
          <textarea
            className="council-textarea"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What should the council debate?"
            rows={2}
          />
        </div>

        {/* Rounds + Response Length */}
        <div className="council-row-inline">
          <div className="council-field">
            <label className="council-label">Rounds</label>
            <input
              className="council-input"
              type="number"
              min={1}
              max={10}
              value={rounds}
              onChange={(e) => setRounds(parseInt(e.target.value) || 2)}
            />
          </div>
          <div className="council-field">
            <label className="council-label">Response Length</label>
            <select
              className="council-select"
              value={responseLength}
              onChange={(e) => setResponseLength(e.target.value)}
            >
              {RESPONSE_LENGTHS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Members */}
        <div className="council-field">
          <div className="council-members-header">
            <label className="council-label">Members</label>
            <button className="council-btn-add" onClick={addMember}>+ add</button>
          </div>

          {members.filter(m => !m.isJudge).map((member, idx) => {
            const actualIdx = members.indexOf(member);
            const color = memberColor(member);
            return (
              <div key={actualIdx} className="council-member">
                <div className="council-member-top">
                  <span className="council-member-dot" style={{ background: color }} />
                  <input
                    className="council-member-name"
                    value={member.name}
                    onChange={(e) => updateMember(actualIdx, { name: e.target.value })}
                    placeholder="Name"
                  />
                  {members.filter(m => !m.isJudge).length > 2 && (
                    <button className="council-member-remove" onClick={() => removeMember(actualIdx)}>×</button>
                  )}
                </div>
                <div className="council-member-selects">
                  <select
                    className="council-member-select"
                    value={member.profile}
                    onChange={(e) => updateMember(actualIdx, { profile: e.target.value })}
                  >
                    {PROFILES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <select
                    className="council-member-select"
                    value={member.stance}
                    onChange={(e) => updateMember(actualIdx, { stance: e.target.value })}
                  >
                    {STANCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
        </div>

        {/* Judge toggle */}
        <div className="council-judge-toggle" onClick={toggleJudge}>
          <div className={`council-toggle-track ${hasJudge ? "council-toggle-track--on" : "council-toggle-track--off"}`}>
            <div className={`council-toggle-knob ${hasJudge ? "council-toggle-knob--on" : "council-toggle-knob--off"}`} />
          </div>
          <span className={`council-judge-label ${hasJudge ? "" : "council-judge-label--dim"}`}>
            Appoint a Judge
          </span>
          <span className="council-judge-hint">delivers final verdict</span>
        </div>

        {/* Judge config */}
        {hasJudge && (() => {
          const judgeIdx = members.findIndex(m => m.isJudge);
          const judge = members[judgeIdx];
          if (!judge) return null;
          return (
            <div className="council-member">
              <div className="council-member-top">
                <span className="council-member-dot" style={{ background: stanceColors.judge }} />
                <input
                  className="council-member-name"
                  value={judge.name}
                  onChange={(e) => updateMember(judgeIdx, { name: e.target.value })}
                  placeholder="Judge name"
                />
                <span className="council-member-badge">JUDGE</span>
              </div>
              <div className="council-member-selects">
                <select
                  className="council-member-select"
                  value={judge.profile}
                  onChange={(e) => updateMember(judgeIdx, { profile: e.target.value })}
                >
                  {PROFILES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <select
                  className="council-member-select"
                  value={judge.stance}
                  onChange={(e) => updateMember(judgeIdx, { stance: e.target.value })}
                >
                  {STANCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Start button */}
      <div className="council-footer" style={{ padding: "10px 12px" }}>
        <button
          className={`council-start-btn ${canStart ? "council-start-btn--ready" : ""}`}
          onClick={() => canStart && onStart({
            topic: topic.trim(),
            roundLimit: rounds,
            responseLength,
            members,
          })}
          disabled={!canStart}
        >
          Convene Council ({members.filter(m => !m.isJudge).length} debaters{hasJudge ? " + judge" : ""})
        </button>
      </div>
    </div>
  );
}

// ── Debate View ──

function DebateView({ state, callOp, refresh, onNewCouncil, onShowHistory, onBack }: {
  state: CouncilState;
  callOp: MoveWidgetProps["callOp"];
  refresh: () => void;
  onNewCouncil?: () => void;
  onShowHistory?: () => void;
  onBack?: () => void;
}) {
  const [broadcast, setBroadcast] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages.length]);

  const handleBroadcast = async () => {
    if (!broadcast.trim()) return;
    await callOp("broadcast", { message: broadcast.trim() });
    setBroadcast("");
    refresh();
  };

  const statusText =
    state.status === "initializing" ? "Initializing..."
    : state.status === "active" ? `Round ${state.currentRound}/${state.roundLimit}`
    : state.status === "judging" ? "Judge deliberating..."
    : "Complete";

  const statusColor =
    state.status === "complete" ? "var(--success)"
    : state.status === "judging" ? stanceColors.judge
    : "var(--info)";

  let prevRound = 0;

  return (
    <div className="council">
      {/* Header */}
      <div className="council-header" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="council-header-left">
            {onBack && (
              <button className="council-btn-ghost council-back-btn" onClick={onBack}>←</button>
            )}
            <span className="council-title">Council</span>
          </div>
          <span className="council-status" style={{ color: statusColor, borderColor: `${statusColor}44` ? undefined : undefined, border: `1px solid color-mix(in srgb, ${statusColor} 25%, transparent)` }}>
            {statusText}
          </span>
        </div>
        <div className="council-topic">{state.topic}</div>
      </div>

      {/* Timeline */}
      <div className="council-body">
        {state.messages.length === 0 ? (
          <div className="council-empty">
            {state.status === "initializing" ? "Members initializing..." : "Waiting for first speaker..."}
          </div>
        ) : (
          state.messages.map((msg, i) => {
            const showRound = msg.round !== prevRound;
            prevRound = msg.round;
            const member = state.members.find(m => m.name === msg.name);
            const color = member ? memberColor(member) : stanceColors[msg.role] || "var(--text)";
            return (
              <div key={i}>
                {showRound && (
                  <div className={`council-round-divider ${i > 0 ? "council-round-divider--border" : ""}`}>
                    Round {msg.round}
                  </div>
                )}
                <div className="council-message">
                  <div className="council-message-header">
                    <span className="council-message-dot" style={{ background: color }} />
                    <span className="council-message-name" style={{ color }}>{msg.name}</span>
                    {member?.isJudge && (
                      <span className="council-member-badge">JUDGE</span>
                    )}
                    <span className="council-message-time">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <div className="council-message-content">{msg.content}</div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Broadcast input */}
      {(state.status === "active" || state.status === "judging") && (
        <div className="council-footer">
          <div className="council-broadcast">
            <input
              className="council-broadcast-input"
              value={broadcast}
              onChange={(e) => setBroadcast(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleBroadcast(); }}
              placeholder="Broadcast to council..."
            />
            <button className="council-btn-ghost" onClick={handleBroadcast}>send</button>
          </div>
        </div>
      )}

      {/* Post-completion actions */}
      {state.status === "complete" && (onNewCouncil || onShowHistory) && (
        <div className="council-footer">
          <div className="council-complete-actions">
            {onNewCouncil && (
              <button className="council-action-btn council-action-btn--primary" onClick={onNewCouncil}>
                New Council
              </button>
            )}
            {onShowHistory && (
              <button className="council-action-btn council-action-btn--dim" onClick={onShowHistory}>
                History
              </button>
            )}
          </div>
        </div>
      )}

      {/* Member bar */}
      <div className="council-member-bar">
        {(state.members || []).map((m, i) => {
          const debaters = state.members.filter(mb => !mb.isJudge);
          const isCurrentSpeaker = state.status === "active" && !m.isJudge &&
            debaters[state.turnIndex]?.sessionId === m.sessionId;
          const isJudging = state.status === "judging" && m.isJudge;
          const active = isCurrentSpeaker || isJudging;
          const color = memberColor(m);
          return (
            <span key={i} className={`council-member-chip ${active ? "council-member-chip--active" : "council-member-chip--inactive"}`} style={active ? { color } : undefined}>
              <span className={`council-chip-dot ${active ? "council-chip-dot--active" : "council-chip-dot--inactive"}`} style={{ background: color }} />
              {m.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Past Councils View ──

interface CouncilSummary {
  instanceId: string;
  topic: string;
  status: string;
  members: number;
  messages: number;
  rounds: string;
}

function PastCouncilsView({ callOp, onBack, onViewCouncil }: {
  callOp: MoveWidgetProps["callOp"];
  onBack: () => void;
  onViewCouncil: (instanceId: string) => void;
}) {
  const [councils, setCouncils] = useState<CouncilSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    callOp("list-councils").then(res => {
      if (res.ok && res.message) {
        try { setCouncils(JSON.parse(res.message)); } catch {}
      }
      setLoading(false);
    });
  }, [callOp]);

  const statusColor = (s: string) =>
    s === "complete" ? "var(--success)" : s === "active" ? "var(--info)" : s === "judging" ? stanceColors.judge : "var(--text-dim)";

  return (
    <div className="council">
      <div className="council-header">
        <span className="council-title">Past Councils</span>
        <button className="council-btn-ghost" onClick={onBack}>back</button>
      </div>
      <div className="council-body">
        {loading ? (
          <div className="council-empty">Loading...</div>
        ) : councils.length === 0 ? (
          <div className="council-empty">No past councils</div>
        ) : (
          councils.map((council) => (
            <div
              key={council.instanceId}
              className="council-history-row"
              onClick={() => onViewCouncil(council.instanceId)}
            >
              <div className="council-history-top">
                <span className="council-history-topic">{council.topic}</span>
                <span className="council-status" style={{ color: statusColor(council.status), border: `1px solid color-mix(in srgb, ${statusColor(council.status)} 25%, transparent)` }}>
                  {council.status}
                </span>
              </div>
              <div className="council-history-meta">
                <span>{council.members} members</span>
                <span>{council.messages} messages</span>
                <span>rounds {council.rounds}</span>
                <span className="council-history-id">{council.instanceId}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Read-only view of a past council ──

function PastCouncilView({ instanceId, callOp, onBack }: {
  instanceId: string;
  callOp: MoveWidgetProps["callOp"];
  onBack: () => void;
}) {
  const [state, setState] = useState<CouncilState | null>(null);

  useEffect(() => {
    callOp("read-instance", { instanceId }).then(res => {
      if (res.ok && res.message) {
        try { setState(JSON.parse(res.message)); } catch {}
      }
    });
  }, [callOp, instanceId]);

  if (!state) {
    return (
      <div className="council-loading">
        <div>
          <div className="council-empty">Loading council {instanceId}...</div>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button className="council-btn-ghost" onClick={onBack}>back</button>
          </div>
        </div>
      </div>
    );
  }

  return <DebateView state={state} callOp={callOp} refresh={() => {}} onBack={onBack} />;
}

// ── Main Widget ──

type View = { type: "setup" } | { type: "active" } | { type: "history" } | { type: "past-council"; instanceId: string };

export default function CouncilWidget({ callOp, activate }: MoveWidgetProps) {
  const [state, setState] = useState<CouncilState | null>(null);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<View>({ type: "setup" });

  const refresh = useCallback(async () => {
    const res = await callOp("read-state");
    if (res.ok && res.message) {
      try {
        const parsed = JSON.parse(res.message);
        setState(parsed);
        if (parsed.status && parsed.status !== "setup") {
          setView({ type: "active" });
        }
      } catch {}
    }
  }, [callOp]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!state || state.status === "setup" || state.status === "complete") return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, state?.status]);

  const handleStart = async (config: {
    topic: string;
    roundLimit: number;
    responseLength: string;
    members: MemberConfig[];
  }) => {
    setStarting(true);
    await callOp("setup", config as any);
    if (activate) {
      await activate();
    }
    setView({ type: "active" });
    setTimeout(refresh, 1000);
    setStarting(false);
  };

  if (starting) {
    return <div className="council-loading">Convening council...</div>;
  }

  if (view.type === "history") {
    return (
      <PastCouncilsView
        callOp={callOp}
        onBack={() => setView(state && state.status !== "setup" ? { type: "active" } : { type: "setup" })}
        onViewCouncil={(id) => setView({ type: "past-council", instanceId: id })}
      />
    );
  }

  if (view.type === "past-council") {
    return (
      <PastCouncilView
        instanceId={view.instanceId}
        callOp={callOp}
        onBack={() => setView({ type: "history" })}
      />
    );
  }

  if (view.type === "setup" || !state || state.status === "setup") {
    return (
      <SetupScreen
        onStart={handleStart}
        onShowHistory={() => setView({ type: "history" })}
      />
    );
  }

  return (
    <DebateView
      state={state}
      callOp={callOp}
      refresh={refresh}
      onNewCouncil={() => { setState(null); setView({ type: "setup" }); }}
      onShowHistory={() => setView({ type: "history" })}
    />
  );
}
