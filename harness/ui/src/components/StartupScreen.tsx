import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { MoLogo } from "./MoLogo";
import {
  getDesktopStartupStatus,
  isTauriRuntime,
  revealDesktopPath,
  stopDesktopStartup,
  type DesktopStartupStatus,
} from "../desktopBridge";
import {
  describeFailure,
  describeStartup,
  formatWait,
  startupReport,
  type StartupFailureView,
  type StartupStage,
  type StartupView,
} from "../startup";

// Loaded only when asked for: it reads the launch target, which is not final
// until startup has rewritten the launch query.
const BackendTargetPanel = lazy(() =>
  import("./BackendTargetManager").then((module) => ({ default: module.BackendTargetPanel })));

const POLL_MS = 250;

type StoreState = { stage: StartupStage; status: DesktopStartupStatus | null };

/**
 * One startup, shared by the bootstrap code that moves it along and the screen
 * that shows it. The screen polls the desktop shell itself while the backend
 * starts, so a bootstrap call that blocks for minutes still has a live screen.
 */
export type StartupStore = ReturnType<typeof createStartupStore>;

export function createStartupStore(vault?: string) {
  let state: StoreState = { stage: { kind: "backend" }, status: null };
  const listeners = new Set<() => void>();
  return {
    vault,
    startedAt: Date.now(),
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setStage(stage: StartupStage) {
      state = { ...state, stage };
      listeners.forEach((listener) => listener());
    },
    setStatus(status: DesktopStartupStatus | null) {
      state = { ...state, status };
      listeners.forEach((listener) => listener());
    },
  };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function StartupScreen({ store }: { store: StartupStore }) {
  const { stage, status } = useSyncExternalStore(store.subscribe, store.get);
  const now = useNow(500);
  const polling = stage.kind === "backend" && isTauriRuntime();

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const poll = () => {
      void getDesktopStartupStatus(store.vault)
        .then((next) => { if (!cancelled) store.setStatus(next); })
        .catch(() => { /* an older shell without the command: the steps still show */ });
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [polling, store]);

  const waitedMs = now - store.startedAt;
  if (stage.kind === "failed") {
    return <StartupFailure stage={stage} status={status} waitedMs={waitedMs} />;
  }
  return (
    <StartupProgressPanel
      view={describeStartup({ stage, status, waitedMs })}
      onStop={() => { void stopDesktopStartup(store.vault).catch(() => {}); }}
    />
  );
}

/** The mark, a moving bar, and one line: what a window shows before it knows more. */
export function StartupSplash({ title }: { title: string }) {
  return (
    <div className="startup-screen">
      <div className="startup-box">
        <MoLogo size={36} className="startup-mark startup-mark--working" />
        <div className="startup-title">{title}</div>
        <div className="startup-bar" role="progressbar" aria-label={title}>
          <span className="startup-bar-step" style={{ left: 0, width: "100%" }}>
            <span className="startup-bar-travel" />
          </span>
        </div>
      </div>
    </div>
  );
}

export function StartupProgressPanel({ view, onStop }: { view: StartupView; onStop?: () => void }) {
  const total = view.steps.length;
  const step = 100 / total;
  const current = view.steps[view.current];
  return (
    <div className="startup-screen">
      <div className="startup-box">
        <MoLogo size={36} className="startup-mark startup-mark--working" />
        <div className="startup-title">{view.title}</div>
        <div
          className="startup-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={view.current}
          aria-valuetext={current?.label}
        >
          <span className="startup-bar-done" style={{ width: `${view.current * step}%` }} />
          <span className="startup-bar-step" style={{ left: `${view.current * step}%`, width: `${step}%` }}>
            <span className="startup-bar-travel" />
          </span>
        </div>
        <ol className="startup-steps">
          {view.steps.map((item) => (
            <li key={item.label} className={`startup-step startup-step--${item.state}`}>
              <span className="startup-step-mark" aria-hidden="true" />
              <span className="startup-step-label">{item.label}</span>
              {item.state === "current" && view.seconds !== null && (
                <span className="startup-step-time">{formatWait(view.seconds)}</span>
              )}
            </li>
          ))}
        </ol>
        <div className="startup-detail" aria-live="polite">{view.detail ?? ""}</div>
        {view.note && <p className="startup-note">{view.note}</p>}
        {view.canStop && onStop && (
          <button type="button" className="startup-quiet" onClick={onStop}>stop waiting</button>
        )}
      </div>
    </div>
  );
}

function StartupFailure({
  stage,
  status,
  waitedMs,
}: {
  stage: Extract<StartupStage, { kind: "failed" }>;
  status: DesktopStartupStatus | null;
  waitedMs: number;
}) {
  // Frozen at the moment of failure, so the counter does not keep running.
  const [failedAfter] = useState(waitedMs);
  const [copied, setCopied] = useState(false);
  const [showTargets, setShowTargets] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const logPath = isTauriRuntime() ? status?.logPath ?? null : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(startupReport(stage, status, failedAfter));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 6_000);
    } catch {
      // Without clipboard access the details stay selectable instead.
      setDetailsOpen(true);
    }
  };

  return (
    <StartupFailurePanel
      failure={describeFailure(stage, status, failedAfter)}
      copied={copied}
      detailsOpen={detailsOpen}
      onToggleDetails={setDetailsOpen}
      onRetry={() => window.location.reload()}
      onCopy={() => { void copy(); }}
      onShowLog={logPath ? () => { void revealDesktopPath(logPath).catch(() => setDetailsOpen(true)); } : undefined}
      onOtherConnections={() => setShowTargets((shown) => !shown)}
      otherConnections={showTargets && (
        <Suspense fallback={null}><BackendTargetPanel embedded /></Suspense>
      )}
    />
  );
}

export function StartupFailurePanel({
  failure,
  copied = false,
  detailsOpen = false,
  onToggleDetails,
  onRetry,
  onCopy,
  onShowLog,
  onOtherConnections,
  otherConnections,
}: {
  failure: StartupFailureView;
  copied?: boolean;
  detailsOpen?: boolean;
  onToggleDetails?: (open: boolean) => void;
  onRetry: () => void;
  onCopy: () => void;
  onShowLog?: () => void;
  onOtherConnections?: () => void;
  otherConnections?: ReactNode;
}) {
  return (
    <div className="startup-screen">
      <div className="startup-box startup-box--failed">
        <MoLogo size={36} className="startup-mark" />
        <div className="startup-headline" role="alert">{failure.headline}</div>
        <p className="startup-reason">{failure.reason}</p>
        <div className="startup-when">{failure.when}</div>
        <div className="startup-actions">
          <button type="button" className="startup-primary" onClick={onRetry}>try again</button>
          <button type="button" className="startup-quiet" onClick={onCopy}>
            {copied ? "copied. paste it into a report or your agent" : "copy details"}
          </button>
          {onShowLog && <button type="button" className="startup-quiet" onClick={onShowLog}>show log</button>}
        </div>
        <details
          className="startup-details"
          open={detailsOpen}
          onToggle={(event) => onToggleDetails?.((event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>what happened</summary>
          <pre>{failure.details}</pre>
        </details>
        {onOtherConnections && (
          <button type="button" className="startup-quiet startup-other" onClick={onOtherConnections}>
            connect to another modus instead
          </button>
        )}
        {otherConnections}
      </div>
    </div>
  );
}
