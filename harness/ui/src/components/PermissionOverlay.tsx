import { useState, useEffect } from "react";
import type { PendingPermission } from "../types";

type Props = {
  permissions: PendingPermission[];
  sessionId: string;
  onRespond: (requestId: string, behavior: "allow" | "deny", updatedInput?: Record<string, unknown>, scope?: "once" | "session") => void;
};

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

/** Render an AskUserQuestion interactive form */
function QuestionForm({ perm, onRespond }: { perm: PendingPermission; onRespond: Props["onRespond"] }) {
  const questions = (perm.toolInput.questions as any[]) ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

  const setAnswer = (question: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [question]: value }));
  };

  const handleSubmit = () => {
    // Merge custom inputs for "Other" selections
    const finalAnswers: Record<string, string> = {};
    for (const q of questions) {
      const qText = q.question as string;
      const ans = answers[qText];
      if (ans === "__other__") {
        finalAnswers[qText] = customInputs[qText] ?? "";
      } else if (ans) {
        finalAnswers[qText] = ans;
      }
    }
    onRespond(perm.requestId, "allow", { ...perm.toolInput, answers: finalAnswers });
  };

  const allAnswered = questions.every((q: any) => {
    const ans = answers[q.question];
    if (!ans) return false;
    if (ans === "__other__" && !customInputs[q.question]?.trim()) return false;
    return true;
  });

  return (
    <div className="permission-questions">
      {questions.map((q: any, qi: number) => (
        <div key={qi} className="permission-question">
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
              onChange={(e) => setCustomInputs((prev) => ({ ...prev, [q.question]: e.target.value }))}
              autoFocus
            />
          )}
        </div>
      ))}
      <div className="permission-actions">
        <button className="permission-btn permission-btn--approve" onClick={handleSubmit} disabled={!allAnswered}>
          Submit
        </button>
        <button className="permission-btn permission-btn--deny" onClick={() => onRespond(perm.requestId, "deny")}>
          Skip
        </button>
      </div>
    </div>
  );
}

export function PermissionOverlay({ permissions, sessionId, onRespond }: Props) {
  // Enter key = Allow (first non-interactive permission)
  useEffect(() => {
    if (permissions.length === 0) return;
    const first = permissions.find((p) => !p.interactive);
    if (!first) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        onRespond(first.requestId, "allow", undefined, "once");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [permissions, onRespond]);

  if (permissions.length === 0) return null;

  return (
    <div className="permission-overlay">
      {permissions.map((perm) => (
        <div key={perm.requestId} className="permission-request">
          {perm.interactive ? (
            <QuestionForm perm={perm} onRespond={onRespond} />
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
      ))}
    </div>
  );
}
