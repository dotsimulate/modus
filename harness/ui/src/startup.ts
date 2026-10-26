/**
 * What the startup screen says while Modus starts, and when it does not.
 *
 * The desktop shell answers `desktop_startup_status` with the backend's phase
 * while `desktop_bootstrap` waits; this window adds the two steps after it
 * (binding its credential, loading the app). Everything here is plain data so
 * the words can be checked without a renderer.
 */
import type { DesktopStartupPhase, DesktopStartupStatus } from "./desktopBridge";

export type StartupStage =
  /** Waiting on the desktop shell to start the managed backend. */
  | { kind: "backend" }
  /** The backend answered; this window is proving its credential. */
  | { kind: "connecting" }
  /** Loading the app itself. */
  | { kind: "opening" }
  | { kind: "failed"; during: "backend" | "connecting"; error: string };

export type StartupSnapshot = {
  stage: StartupStage;
  status: DesktopStartupStatus | null;
  /** Milliseconds this window has been waiting. */
  waitedMs: number;
};

export type StartupStep = { label: string; state: "done" | "current" | "waiting" };

export type StartupView = {
  title: string;
  steps: StartupStep[];
  /** Index of the current step, for the bar: steps before it are filled. */
  current: number;
  /** Whole seconds waited, shown once a step has taken a moment. */
  seconds: number | null;
  /** A quieter line under the steps: the engine's latest output, or a retry. */
  detail: string | null;
  /** Said once the wait is long enough to wonder about. */
  note: string | null;
  /** Long waits offer a way out rather than an unexplained spinner. */
  canStop: boolean;
};

/** A wait is counted once it is long enough to notice (Voro's splash does the same). */
const COUNT_AFTER_MS = 3_000;
const NOTE_AFTER_MS = 15_000;
const STOP_AFTER_MS = 60_000;
const DETAIL_CHARS = 140;

const BACKEND_STEP: Record<DesktopStartupPhase, number> = {
  idle: 0,
  preparing: 0,
  launching: 0,
  retrying: 0,
  loading: 1,
  verifying: 2,
  tailnet: 2,
  ready: 2,
  failed: 0,
};

function waited(snapshot: StartupSnapshot): number {
  // A window opened onto a start already running (a reload, the mini viewer)
  // has waited as long as that start, not only since it appeared.
  const backend = snapshot.stage.kind === "backend" ? snapshot.status?.elapsedMs ?? 0 : 0;
  return Math.max(snapshot.waitedMs, backend);
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

function clip(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > DETAIL_CHARS ? `${trimmed.slice(0, DETAIL_CHARS - 1)}…` : trimmed;
}

export function describeStartup(snapshot: StartupSnapshot): StartupView {
  const { stage, status } = snapshot;
  const firstStart = status?.firstStart ?? false;
  const labels = [
    "start the engine",
    firstStart ? "set up your modus home" : "load your modus home",
    "connect this window",
    "open modus",
  ];
  const current = stage.kind === "opening"
    ? 3
    : stage.kind === "connecting"
      ? 2
      : BACKEND_STEP[status?.phase ?? "idle"];
  const steps = labels.map((label, index): StartupStep => ({
    label,
    state: index < current ? "done" : index === current ? "current" : "waiting",
  }));
  const ms = waited(snapshot);

  let detail: string | null = null;
  if (stage.kind === "backend" && status) {
    if (status.phase === "retrying") {
      detail = `the engine stopped while starting; trying again (${status.attempt + 1} of ${status.attempts})`;
    } else if (status.phase === "tailnet") {
      detail = "reconnecting tailnet access";
    } else if (status.attempt > 1 && status.phase !== "loading") {
      detail = `try ${status.attempt} of ${status.attempts}`;
    } else if (status.phase === "loading" && status.lines.length > 0) {
      detail = clip(status.lines[status.lines.length - 1]);
    }
  }

  let note: string | null = null;
  if (ms >= NOTE_AFTER_MS && stage.kind !== "opening") {
    note = firstStart
      ? "the first start sets modus up on this computer, so it takes longer than later ones. this window opens by itself when it is ready."
      : "this is taking longer than usual. modus is still working, and this window opens by itself when it is ready.";
  }

  return {
    title: stage.kind === "opening" ? "opening modus" : firstStart ? "setting up modus" : "starting modus",
    steps,
    current,
    seconds: ms >= COUNT_AFTER_MS ? Math.floor(ms / 1000) : null,
    detail,
    note,
    canStop: stage.kind === "backend" && ms >= STOP_AFTER_MS && !!status && status.phase !== "ready",
  };
}

export type StartupFailureView = {
  headline: string;
  /** What happened, in a sentence a first-time user can act on. */
  reason: string;
  /** Everything known, for the details pane and the copied report. */
  details: string;
  /** "after 47 s", with the attempt when more than one ran. */
  when: string;
};

function plainReason(error: string, during: "backend" | "connecting"): string {
  if (/stopped from the window/i.test(error)) return "you stopped the start.";
  if (/exited before readiness/i.test(error)) return "the modus engine stopped while it was starting.";
  if (/timed out/i.test(error)) return "the modus engine did not become ready in time.";
  if (/is missing:/i.test(error)) return "part of the modus installation is missing. installing modus again should fix it.";
  if (during === "connecting") return "the modus engine started, but this window could not connect to it.";
  const first = error.split("\n")[0]?.trim();
  return first || "the modus engine did not start.";
}

export function describeFailure(
  stage: Extract<StartupStage, { kind: "failed" }>,
  status: DesktopStartupStatus | null,
  waitedMs: number,
): StartupFailureView {
  const seconds = Math.floor(Math.max(waitedMs, status?.elapsedMs ?? 0) / 1000);
  const attempts = status && status.attempt > 1 ? `, try ${status.attempt} of ${status.attempts}` : "";
  const output = status?.lines.length
    ? `\n\nlast output from the engine:\n${status.lines.join("\n")}`
    : "";
  return {
    headline: /stopped from the window/i.test(stage.error) ? "modus stopped starting" : "modus did not start",
    reason: plainReason(stage.error, stage.during),
    details: `${stage.error.trim()}${output}`,
    when: `after ${formatWait(seconds)}${attempts}`,
  };
}

/** Plain text a person can paste into a bug report or hand to an agent. */
export function startupReport(
  stage: Extract<StartupStage, { kind: "failed" }>,
  status: DesktopStartupStatus | null,
  waitedMs: number,
): string {
  const failure = describeFailure(stage, status, waitedMs);
  return [
    `${failure.headline} (${failure.when})`,
    `modus desktop ${status?.version ?? "unknown version"}${status?.firstStart ? ", first start" : ""}`,
    `while: ${stage.during === "connecting" ? "connecting this window" : `starting the engine (${status?.phase ?? "unknown"})`}`,
    `reason: ${failure.reason}`,
    "",
    failure.details,
    ...(status?.logPath ? ["", `log: ${status.logPath}`] : []),
  ].join("\n");
}
