import { useState, useEffect } from "react";
import type { PendingPermission } from "../../../sdk/index";

type Props = {
  permissions: PendingPermission[];
  sessionId: string;
  onRespond: (requestId: string, behavior: "allow" | "deny", updatedInput?: Record<string, unknown>, scope?: "once" | "session") => void;
};

// ── Persistent answer state (survives component unmount/remount) ──

type FormState = {
  step: number;
  answers: Record<string, string>;
  customInputs: Record<string, string>;
};

const formStore = new Map<string, FormState>();
/** Active permission tab index — survives navigation */
let persistedActiveIdx = 0;
/** Collapsed state for interactive (AskUserQuestion) permissions */
const collapsedStore = new Map<string, boolean>();

function getFormState(requestId: string): FormState {
  return formStore.get(requestId) ?? { step: 0, answers: {}, customInputs: {} };
}

function setFormState(requestId: string, patch: Partial<FormState>) {
  const prev = getFormState(requestId);
  formStore.set(requestId, { ...prev, ...patch });
}

/** Summarize tool input for display */
function inputSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return (input.command as string) ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return ((input.file_path as string) ?? "").replace(/^\/home\/[^/]+\//, "~/");
    case "Grep":
      return `/${input.pattern}/`;
    case "Glob":
      return String(input.pattern ?? "");
    case "WebFetch":
      return (input.url as string) ?? "";
    case "WebSearch":
      return (input.query as string) ?? "";
    default:
      return "";
  }
}

/** Render an AskUserQuestion interactive form — one question at a time */
function QuestionForm({ perm, onRespond, collapsed, onToggleCollapse }: {
  perm: PendingPermission;
  onRespond: Props["onRespond"];
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const questions = (perm.toolInput.questions as any[]) ?? [];
  const saved = getFormState(perm.requestId);

  // Local state initialized from persistent store
  const [step, _setStep] = useState(saved.step);
  const [answers, _setAnswers] = useState(saved.answers);
  const [customInputs, _setCustomInputs] = useState(saved.customInputs);

  // Wrap setters to persist to module store
  const setStep = (s: number) => {
    _setStep(s);
    setFormState(perm.requestId, { step: s });
  };
  const setAnswer = (question: string, value: string) => {
    _setAnswers((prev) => {
      const next = { ...prev, [question]: value };
      setFormState(perm.requestId, { answers: next });
      return next;
    });
  };
  const setCustomInput = (question: string, value: string) => {
    _setCustomInputs((prev) => {
      const next = { ...prev, [question]: value };
      setFormState(perm.requestId, { customInputs: next });
      return next;
    });
  };

  const q = questions[step];
  const total = questions.length;
  const isLast = step === total - 1;

  const currentAnswered = (() => {
    if (!q) return false;
    const ans = answers[q.question];
    if (!ans) return false;
    if (ans === "__other__" && !customInputs[q.question]?.trim()) return false;
    return true;
  })();

  const handleNext = () => {
    if (isLast) {
      // Submit all answers and clean up store
      const finalAnswers: Record<string, string> = {};
      for (const qq of questions) {
        const qText = qq.question as string;
        const ans = answers[qText];
        if (ans === "__other__") {
          finalAnswers[qText] = customInputs[qText] ?? "";
        } else if (ans) {
          finalAnswers[qText] = ans;
        }
      }
      formStore.delete(perm.requestId);
      onRespond(perm.requestId, "allow", { ...perm.toolInput, answers: finalAnswers });
    } else {
      setStep(step + 1);
    }
  };

  if (!q) return null;

  return (
    <div className="permission-questions">
      <button className="permission-question-collapse" onClick={onToggleCollapse}>
        <span className="permission-question-collapse-indicator" />
        <span className="permission-question-collapse-label">{q.question}</span>
        <span className="permission-question-collapse-chevron">{collapsed ? "▸" : "▾"}</span>
      </button>
      <div className={`permission-question-body${collapsed ? " collapsed" : ""}`}>
      <div className="permission-question-body-inner">
      {/* Bounded scroll. The inner wrapper is overflow:hidden to serve the
          collapse animation, so without this a long question is clipped with no
          way to reach the rest of it. */}
      <div className="permission-question-scroll">
      {total > 1 && (
        <div className="question-steps">
          {questions.map((_: any, i: number) => (
            <button
              key={i}
              className={`question-step${i === step ? " active" : ""}${answers[questions[i].question] ? " answered" : ""}`}
              onClick={() => setStep(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      <div className="permission-question">
        <div className="permission-question-header">{q.header}</div>
        <div className="permission-question-text">{q.question}</div>
        <div className="permission-options">
          {(q.options ?? []).map((opt: any, oi: number) => (
            <button
              key={oi}
              className={`permission-option${answers[q.question] === opt.label ? " selected" : ""}`}
              onClick={() => setAnswer(q.question, opt.label)}
            >
              <span className="permission-option-label">{opt.label}</span>
              {opt.description && <span className="permission-option-desc">{opt.description}</span>}
            </button>
          ))}
          <button
            className={`permission-option${answers[q.question] === "__other__" ? " selected" : ""}`}
            onClick={() => setAnswer(q.question, "__other__")}
          >
            <span className="permission-option-label">Other</span>
          </button>
        </div>
        {answers[q.question] === "__other__" && (
          <input
            className="permission-other-input"
            type="text"
            placeholder="Type your answer..."
            value={customInputs[q.question] ?? ""}
            onChange={(e) => setCustomInput(q.question, e.target.value)}
            autoFocus
          />
        )}
      </div>

      </div>
      </div>
      </div>
      {/* Outside the collapsible, clipped container on purpose. Rendered inside
          it, the primary action became unreachable as soon as the options were
          tall enough to overflow — selectable answers, no way to submit them,
          and no signal to the agent, which just waits. */}
      {!collapsed && (
        <div className="permission-actions">
          {step > 0 && (
            <button className="permission-btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button className="permission-btn permission-btn--approve" onClick={handleNext} disabled={!currentAnswered}>
            {isLast ? "Submit" : "Next"}
          </button>
          <button className="permission-btn permission-btn--deny" onClick={() => {
            formStore.delete(perm.requestId);
            onRespond(perm.requestId, "deny");
          }}>
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

export function PermissionOverlay({ permissions, sessionId: _sessionId, onRespond }: Props) {
  const [activeIdx, _setActiveIdx] = useState(persistedActiveIdx);
  const setActiveIdx = (i: number) => { persistedActiveIdx = i; _setActiveIdx(i); };
  const [, forceUpdate] = useState(0);
  const toggleCollapsed = (requestId: string) => {
    collapsedStore.set(requestId, !collapsedStore.get(requestId));
    forceUpdate(n => n + 1);
  };

  // Clamp active index when permissions change
  useEffect(() => {
    if (activeIdx >= permissions.length) setActiveIdx(Math.max(0, permissions.length - 1));
  }, [permissions.length]);

  // Clean up stale form store entries for permissions that no longer exist
  useEffect(() => {
    const ids = new Set(permissions.map((p) => p.requestId));
    for (const key of formStore.keys()) {
      if (!ids.has(key)) formStore.delete(key);
    }
  }, [permissions]);

  // Enter key = Allow (active non-interactive permission)
  useEffect(() => {
    if (permissions.length === 0) return;
    const perm = permissions[activeIdx];
    if (!perm || perm.interactive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        onRespond(perm.requestId, "allow", undefined, "once");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [permissions, activeIdx, onRespond]);

  if (permissions.length === 0) return null;

  const perm = permissions[activeIdx];
  if (!perm) return null;

  return (
    <div className="permission-overlay">
      {permissions.length > 1 && (
        <div className="permission-tabs">
          {permissions.map((p, i) => (
            <button
              key={p.requestId}
              className={`permission-tab${i === activeIdx ? " active" : ""}`}
              onClick={() => setActiveIdx(i)}
            >
              {p.interactive ? "Q" : p.toolName.slice(0, 4)}
              {i === activeIdx && <span className="permission-tab-dot" />}
            </button>
          ))}
        </div>
      )}

      <div className="permission-request">
        {perm.interactive ? (
          <QuestionForm perm={perm} onRespond={onRespond} collapsed={!!collapsedStore.get(perm.requestId)} onToggleCollapse={() => toggleCollapsed(perm.requestId)} />
        ) : (
          <>
            <div className="permission-request-header">
              <span className="permission-request-indicator" />
              <span className="permission-request-tool">{perm.toolName}</span>
              <span className="permission-request-reason">{perm.decisionReason}</span>
            </div>
            {inputSummary(perm.toolName, perm.toolInput) && (
              <pre className="permission-request-input">{inputSummary(perm.toolName, perm.toolInput)}</pre>
            )}
            <div className="permission-actions">
              <button className="permission-btn permission-btn--approve" onClick={() => onRespond(perm.requestId, "allow", undefined, "once")}>
                Allow
              </button>
              <button className="permission-btn permission-btn--session" onClick={() => onRespond(perm.requestId, "allow", undefined, "session")}>
                Allow for Session
              </button>
              <button className="permission-btn permission-btn--deny" onClick={() => onRespond(perm.requestId, "deny")}>
                Deny
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
