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

const c = {
  bg: "var(--bg, #000)",
  surface: "var(--bg-surface, #111)",
  border: "var(--border, #2a2a2a)",
  text: "var(--text, #e0e0e0)",
  dim: "var(--text-dim, #555)",
  label: "var(--text-label, #888)",
  accent: "var(--accent, #4a9eff)",
  error: "var(--error, #f87171)",
};

const inputStyle = {
  background: c.surface,
  border: `1px solid ${c.border}`,
  borderRadius: 4,
  color: c.text,
  fontFamily: "inherit",
  fontSize: 12,
  padding: "6px 8px",
  outline: "none",
};

const labelStyle = {
  fontSize: 10,
  color: c.dim,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
};

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
  const [hover, setHover] = useState(false);

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
        // Add a judge member
        setMembers(prev => [...prev, { name: "Judge", profile: "default", stance: "none", isJudge: true }]);
      } else {
        // Remove judge members
        setMembers(prev => {
          const filtered = prev.filter(m => !m.isJudge);
          return filtered.length >= 2 ? filtered : filtered;
        });
      }
      return next;
    });
  };

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      fontFamily: "var(--font-mono, monospace)",
      background: c.bg,
      overflow: "hidden",
    }}>
      <div style={{
        padding: "12px 14px 8px",
        borderBottom: `1px solid ${c.border}`,
        flexShrink: 0,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span style={{ fontSize: 11, color: c.label, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Configure Council
        </span>
        {onShowHistory && (
          <button
            onClick={onShowHistory}
            style={{
              background: "transparent", border: `1px solid ${c.border}`, borderRadius: 3,
              color: c.dim, fontFamily: "inherit", fontSize: 10, padding: "2px 8px", cursor: "pointer",
            }}
          >
            history
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Topic */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={labelStyle}>Topic</label>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What should the council debate?"
            rows={2}
            style={{ ...inputStyle, padding: "8px 10px", resize: "vertical", lineHeight: "1.5" }}
          />
        </div>

        {/* Rounds + Response Length row */}
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 70 }}>
            <label style={labelStyle}>Rounds</label>
            <input
              type="number"
              min={1}
              max={10}
              value={rounds}
              onChange={(e) => setRounds(parseInt(e.target.value) || 2)}
              style={{ ...inputStyle, width: "100%" }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
            <label style={labelStyle}>Response Length</label>
            <select
              value={responseLength}
              onChange={(e) => setResponseLength(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              {RESPONSE_LENGTHS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Members */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label style={labelStyle}>Members</label>
            <button
              onClick={addMember}
              style={{
                background: "transparent", border: `1px solid ${c.border}`, borderRadius: 3,
                color: c.accent, fontFamily: "inherit", fontSize: 10, padding: "2px 8px",
                cursor: "pointer", letterSpacing: "0.03em",
              }}
            >
              + add
            </button>
          </div>

          {members.filter(m => !m.isJudge).map((member, idx) => {
            const actualIdx = members.indexOf(member);
            const color = memberColor(member);
            return (
              <div key={actualIdx} style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "8px 10px",
                borderRadius: 4,
                border: `1px solid ${color}22`,
                background: `${color}06`,
              }}>
                {/* Name + remove */}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <div style={{ width: 4, height: 24, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <input
                    value={member.name}
                    onChange={(e) => updateMember(actualIdx, { name: e.target.value })}
                    style={{ ...inputStyle, flex: 1, fontSize: 11, padding: "4px 6px" }}
                    placeholder="Name"
                  />
                  {members.filter(m => !m.isJudge).length > 2 && (
                    <button
                      onClick={() => removeMember(actualIdx)}
                      style={{
                        background: "transparent", border: "none", color: c.dim,
                        cursor: "pointer", fontSize: 14, padding: "0 4px", lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
                {/* Profile + Stance row */}
                <div style={{ display: "flex", gap: 6 }}>
                  <select
                    value={member.profile}
                    onChange={(e) => updateMember(actualIdx, { profile: e.target.value })}
                    style={{ ...inputStyle, flex: 1, fontSize: 10, padding: "3px 6px", cursor: "pointer" }}
                  >
                    {PROFILES.map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <select
                    value={member.stance}
                    onChange={(e) => updateMember(actualIdx, { stance: e.target.value })}
                    style={{ ...inputStyle, flex: 1, fontSize: 10, padding: "3px 6px", cursor: "pointer" }}
                  >
                    {STANCES.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </div>

        {/* Judge toggle */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 10px", borderRadius: 4,
          border: `1px solid ${hasJudge ? stanceColors.judge + "33" : c.border}`,
          background: hasJudge ? `${stanceColors.judge}06` : "transparent",
          cursor: "pointer",
        }} onClick={toggleJudge}>
          <div style={{
            width: 28, height: 16, borderRadius: 8,
            background: hasJudge ? c.accent : c.border,
            position: "relative", transition: "background 0.15s",
          }}>
            <div style={{
              width: 12, height: 12, borderRadius: 6,
              background: c.text, position: "absolute", top: 2,
              left: hasJudge ? 14 : 2, transition: "left 0.15s",
            }} />
          </div>
          <span style={{ fontSize: 11, color: hasJudge ? c.text : c.dim }}>
            Appoint a Judge
          </span>
          <span style={{ fontSize: 9, color: c.dim, marginLeft: "auto" }}>
            delivers final verdict
          </span>
        </div>

        {/* Judge config (if enabled) */}
        {hasJudge && (() => {
          const judgeIdx = members.findIndex(m => m.isJudge);
          const judge = members[judgeIdx];
          if (!judge) return null;
          return (
            <div style={{
              display: "flex", flexDirection: "column", gap: 6,
              padding: "8px 10px", borderRadius: 4,
              border: `1px solid ${stanceColors.judge}22`,
              background: `${stanceColors.judge}06`,
            }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <div style={{ width: 4, height: 24, borderRadius: 2, background: stanceColors.judge, flexShrink: 0 }} />
                <input
                  value={judge.name}
                  onChange={(e) => updateMember(judgeIdx, { name: e.target.value })}
                  style={{ ...inputStyle, flex: 1, fontSize: 11, padding: "4px 6px" }}
                  placeholder="Judge name"
                />
                <span style={{ fontSize: 9, color: stanceColors.judge, flexShrink: 0 }}>JUDGE</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <select
                  value={judge.profile}
                  onChange={(e) => updateMember(judgeIdx, { profile: e.target.value })}
                  style={{ ...inputStyle, flex: 1, fontSize: 10, padding: "3px 6px", cursor: "pointer" }}
                >
                  {PROFILES.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <select
                  value={judge.stance}
                  onChange={(e) => updateMember(judgeIdx, { stance: e.target.value })}
                  style={{ ...inputStyle, flex: 1, fontSize: 10, padding: "3px 6px", cursor: "pointer" }}
                >
                  {STANCES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Start button */}
      <div style={{ padding: "10px 14px", borderTop: `1px solid ${c.border}`, flexShrink: 0 }}>
        <button
          onClick={() => canStart && onStart({
            topic: topic.trim(),
            roundLimit: rounds,
            responseLength,
            members,
          })}
          disabled={!canStart}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          style={{
            width: "100%",
            padding: "10px",
            background: canStart && hover ? "rgba(74, 158, 255, 0.1)" : "transparent",
            border: `1px solid ${canStart ? c.accent : c.border}`,
            borderRadius: 4,
            color: canStart ? c.accent : c.dim,
            fontFamily: "inherit",
            fontSize: 12,
            cursor: canStart ? "pointer" : "default",
            letterSpacing: "0.03em",
            transition: "all 0.15s",
          }}
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
    state.status === "complete" ? "#4ade80"
    : state.status === "judging" ? stanceColors.judge
    : c.accent;

  let prevRound = 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: c.bg, fontFamily: "var(--font-mono, monospace)" }}>

      {/* Header */}
      <div style={{ padding: "10px 12px", borderBottom: `1px solid ${c.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {onBack && (
              <button onClick={onBack} style={{
                background: "transparent", border: "none", color: c.dim,
                cursor: "pointer", fontSize: 12, padding: "0 2px", fontFamily: "inherit",
              }}>←</button>
            )}
            <span style={{ fontSize: 11, color: c.label, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Council
            </span>
          </div>
          <span style={{
            fontSize: 10, color: statusColor,
            padding: "2px 6px",
            border: `1px solid ${statusColor}44`,
            borderRadius: 3,
          }}>
            {statusText}
          </span>
        </div>
        <div style={{ fontSize: 11, color: c.dim, marginTop: 4, lineHeight: "1.4" }}>
          {state.topic}
        </div>
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {state.messages.length === 0 ? (
          <div style={{ color: c.dim, fontSize: 11, textAlign: "center", marginTop: 40 }}>
            {state.status === "initializing" ? "Members initializing..." : "Waiting for first speaker..."}
          </div>
        ) : (
          state.messages.map((msg, i) => {
            const showRound = msg.round !== prevRound;
            prevRound = msg.round;
            // Find matching member for color
            const member = state.members.find(m => m.name === msg.name);
            const color = member
              ? memberColor(member)
              : stanceColors[msg.role] || c.text;
            return (
              <div key={i}>
                {showRound && (
                  <div style={{
                    padding: "6px 12px", margin: "4px 0", fontSize: 10,
                    color: c.dim, textTransform: "uppercase", letterSpacing: "0.1em",
                    borderTop: i > 0 ? `1px solid ${c.border}` : "none",
                  }}>
                    Round {msg.round}
                  </div>
                )}
                <div style={{
                  padding: "6px 12px 10px",
                  borderLeft: `2px solid ${color}`,
                  marginLeft: 12,
                  marginBottom: 2,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color }}>{msg.name}</span>
                    {member?.isJudge && (
                      <span style={{ fontSize: 8, color: stanceColors.judge, border: `1px solid ${stanceColors.judge}44`, borderRadius: 2, padding: "0 4px" }}>JUDGE</span>
                    )}
                    <span style={{ fontSize: 9, color: c.dim }}>
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: "1.5", color: c.text, whiteSpace: "pre-wrap" }}>
                    {msg.content}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Broadcast input — when active or judging */}
      {(state.status === "active" || state.status === "judging") && (
        <div style={{ borderTop: `1px solid ${c.border}`, padding: "8px 12px", display: "flex", gap: 6, flexShrink: 0 }}>
          <input
            value={broadcast}
            onChange={(e) => setBroadcast(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleBroadcast(); }}
            placeholder="Broadcast to council..."
            style={{
              flex: 1, background: c.surface, border: `1px solid ${c.border}`, borderRadius: 3,
              color: c.text, fontFamily: "var(--font-mono, monospace)", fontSize: 11, padding: "5px 8px", outline: "none",
            }}
          />
          <button
            onClick={handleBroadcast}
            style={{
              background: "transparent", border: `1px solid ${c.border}`, borderRadius: 3,
              color: c.dim, fontFamily: "var(--font-mono, monospace)", fontSize: 10, padding: "4px 8px", cursor: "pointer",
            }}
          >
            send
          </button>
        </div>
      )}

      {/* Post-completion actions */}
      {state.status === "complete" && (onNewCouncil || onShowHistory) && (
        <div style={{ borderTop: `1px solid ${c.border}`, padding: "8px 12px", display: "flex", gap: 6, flexShrink: 0, justifyContent: "center" }}>
          {onNewCouncil && (
            <button
              onClick={onNewCouncil}
              style={{
                background: "transparent", border: `1px solid ${c.border}`, borderRadius: 3,
                color: c.accent, fontFamily: "var(--font-mono, monospace)", fontSize: 11, padding: "6px 14px", cursor: "pointer",
                letterSpacing: "0.03em",
              }}
            >
              New Council
            </button>
          )}
          {onShowHistory && (
            <button
              onClick={onShowHistory}
              style={{
                background: "transparent", border: `1px solid ${c.border}`, borderRadius: 3,
                color: c.dim, fontFamily: "var(--font-mono, monospace)", fontSize: 11, padding: "6px 14px", cursor: "pointer",
                letterSpacing: "0.03em",
              }}
            >
              History
            </button>
          )}
        </div>
      )}

      {/* Member bar */}
      <div style={{ borderTop: `1px solid ${c.border}`, padding: "6px 12px", display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
        {(state.members || []).map((m, i) => {
          const debaters = state.members.filter(mb => !mb.isJudge);
          const isCurrentSpeaker = state.status === "active" && !m.isJudge &&
            debaters[state.turnIndex]?.sessionId === m.sessionId;
          const isJudging = state.status === "judging" && m.isJudge;
          const active = isCurrentSpeaker || isJudging;
          const color = memberColor(m);
          return (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: active ? color : c.dim }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, opacity: active ? 1 : 0.4 }} />
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
    s === "complete" ? "#4ade80" : s === "active" ? c.accent : s === "judging" ? stanceColors.judge : c.dim;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: c.bg, fontFamily: "var(--font-mono, monospace)" }}>
      <div style={{
        padding: "10px 14px", borderBottom: `1px solid ${c.border}`, flexShrink: 0,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontSize: 11, color: c.label, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Past Councils
        </span>
        <button
          onClick={onBack}
          style={{
            background: "transparent", border: `1px solid ${c.border}`, borderRadius: 3,
            color: c.dim, fontFamily: "inherit", fontSize: 10, padding: "2px 8px", cursor: "pointer",
          }}
        >
          back
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {loading ? (
          <div style={{ color: c.dim, fontSize: 11, textAlign: "center", marginTop: 40 }}>Loading...</div>
        ) : councils.length === 0 ? (
          <div style={{ color: c.dim, fontSize: 11, textAlign: "center", marginTop: 40 }}>No past councils</div>
        ) : (
          councils.map((council) => (
            <div
              key={council.instanceId}
              onClick={() => onViewCouncil(council.instanceId)}
              style={{
                padding: "8px 14px", cursor: "pointer",
                borderBottom: `1px solid ${c.border}`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: c.text, fontWeight: 500 }}>
                  {council.topic.length > 50 ? council.topic.slice(0, 50) + "..." : council.topic}
                </span>
                <span style={{
                  fontSize: 9, color: statusColor(council.status),
                  padding: "1px 5px", border: `1px solid ${statusColor(council.status)}44`,
                  borderRadius: 2,
                }}>
                  {council.status}
                </span>
              </div>
              <div style={{ fontSize: 9, color: c.dim, display: "flex", gap: 10 }}>
                <span>{council.members} members</span>
                <span>{council.messages} messages</span>
                <span>rounds {council.rounds}</span>
                <span style={{ color: c.dim, opacity: 0.5 }}>{council.instanceId}</span>
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
      <div style={{
        display: "flex", flexDirection: "column", height: "100%", background: c.bg,
        fontFamily: "var(--font-mono, monospace)", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{ color: c.dim, fontSize: 11 }}>Loading council {instanceId}...</div>
        <button onClick={onBack} style={{
          marginTop: 12, background: "transparent", border: `1px solid ${c.border}`,
          borderRadius: 3, color: c.dim, fontFamily: "inherit", fontSize: 10, padding: "4px 10px", cursor: "pointer",
        }}>
          back
        </button>
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
        // If council is running, show it
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
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center", height: "100%",
        fontFamily: "var(--font-mono, monospace)", background: c.bg, color: c.label, fontSize: 12,
      }}>
        Convening council...
      </div>
    );
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
