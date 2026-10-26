import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "../../ui/node_modules/react";
import { renderToStaticMarkup } from "../../ui/node_modules/react-dom/server";
import type { DesktopStartupPhase, DesktopStartupStatus } from "../../ui/src/desktopBridge";
import {
  createStartupStore,
  StartupFailurePanel,
  StartupProgressPanel,
  StartupSplash,
} from "../../ui/src/components/StartupScreen";
import {
  describeFailure,
  describeStartup,
  formatWait,
  startupReport,
  type StartupStage,
} from "../../ui/src/startup";

function status(phase: DesktopStartupPhase, patch: Partial<DesktopStartupStatus> = {}): DesktopStartupStatus {
  return {
    phase,
    elapsedMs: 0,
    firstStart: false,
    attempt: 1,
    attempts: 3,
    lines: [],
    error: null,
    logPath: "C:\\Users\\person\\.modus\\logs\\desktop-backend.log",
    version: "0.3.7",
    ...patch,
  };
}

function backend(phase: DesktopStartupPhase, patch: Partial<DesktopStartupStatus> = {}, waitedMs = 0) {
  return describeStartup({ stage: { kind: "backend" }, status: status(phase, patch), waitedMs });
}

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node, ...elements((node.props as { children?: ReactNode }).children)];
}

const failed = (error: string, during: "backend" | "connecting" = "backend") =>
  ({ kind: "failed", during, error }) as Extract<StartupStage, { kind: "failed" }>;

describe("startup steps", () => {
  test("each backend phase lands on the step a person would recognise", () => {
    const current = (phase: DesktopStartupPhase) =>
      backend(phase).steps.find((step) => step.state === "current")?.label;
    expect(current("preparing")).toBe("start the engine");
    expect(current("launching")).toBe("start the engine");
    expect(current("loading")).toBe("load your modus home");
    expect(current("verifying")).toBe("connect this window");
    expect(current("tailnet")).toBe("connect this window");
    expect(describeStartup({ stage: { kind: "opening" }, status: null, waitedMs: 0 }).steps.at(-1)?.state)
      .toBe("current");

    const loading = backend("loading");
    expect(loading.current).toBe(1);
    expect(loading.steps.map((step) => step.state)).toEqual(["done", "current", "waiting", "waiting"]);
  });

  test("a first start says it is setting Modus up, and says so when it is slow", () => {
    const view = backend("loading", { firstStart: true }, 20_000);
    expect(view.title).toBe("setting up modus");
    expect(view.steps[1].label).toBe("set up your modus home");
    expect(view.note).toContain("first start");
    expect(backend("loading", {}, 20_000).note).toContain("taking longer than usual");
    expect(backend("loading", {}, 10_000).note).toBeNull();
  });

  test("the wait is counted after a moment and a long one can be stopped", () => {
    expect(backend("launching", {}, 2_000).seconds).toBeNull();
    expect(backend("launching", {}, 12_400).seconds).toBe(12);
    expect(backend("launching", {}, 59_000).canStop).toBe(false);
    expect(backend("launching", {}, 61_000).canStop).toBe(true);
    expect(describeStartup({ stage: { kind: "connecting" }, status: status("ready"), waitedMs: 90_000 }).canStop)
      .toBe(false);
  });

  test("a window opened onto a start already running counts that start's time", () => {
    expect(backend("loading", { elapsedMs: 75_000 }, 1_000).seconds).toBe(75);
  });

  test("the quiet line is the engine's latest output, a retry, or the tailnet step", () => {
    expect(backend("loading", { lines: ["[db] one", "[modus-home] two"] }).detail).toBe("[modus-home] two");
    expect(backend("loading", { lines: ["x".repeat(400)] }).detail).toHaveLength(140);
    expect(backend("retrying", { attempt: 1 }).detail)
      .toBe("the engine stopped while starting; trying again (2 of 3)");
    expect(backend("preparing", { attempt: 2 }).detail).toBe("try 2 of 3");
    expect(backend("tailnet").detail).toBe("reconnecting tailnet access");
    expect(backend("launching").detail).toBeNull();
  });

  test("waits read as seconds, then minutes", () => {
    expect(formatWait(7)).toBe("7 s");
    expect(formatWait(60)).toBe("1 min");
    expect(formatWait(185)).toBe("3 min 5 s");
  });
});

describe("startup failure", () => {
  test("names what happened in plain words", () => {
    const reason = (error: string, during: "backend" | "connecting" = "backend") =>
      describeFailure(failed(error, during), null, 0).reason;
    expect(reason("packaged backend exited before readiness (exit code: 1)\nRecent backend stderr:\nSQLITE_BUSY"))
      .toBe("the modus engine stopped while it was starting.");
    expect(reason("timed out after 300 s waiting for packaged backend readiness"))
      .toBe("the modus engine did not become ready in time.");
    expect(reason("packaged backend is missing: C:\\Modus\\server.js")).toContain("installing modus again");
    expect(reason("Managed backend session-token exchange failed (503)", "connecting"))
      .toBe("the modus engine started, but this window could not connect to it.");
    expect(reason("something new\nwith detail")).toBe("something new");
    const stopped = describeFailure(failed("the start was stopped from the window before the backend was ready"), null, 0);
    expect(stopped.headline).toBe("modus stopped starting");
    expect(stopped.reason).toBe("you stopped the start.");
  });

  test("says when it failed and keeps the engine's output for the details", () => {
    const view = describeFailure(
      failed("packaged backend exited before readiness (exit code: 1)"),
      status("failed", { attempt: 3, elapsedMs: 47_900, lines: ["[db] opening", "error: SQLITE_BUSY"] }),
      1_000,
    );
    expect(view.when).toBe("after 47 s, try 3 of 3");
    expect(view.details).toContain("exit code: 1");
    expect(view.details).toContain("last output from the engine:\n[db] opening\nerror: SQLITE_BUSY");
  });

  test("the copied report carries the version, the step, the reason, and the log", () => {
    const report = startupReport(
      failed("timed out after 300 s waiting for packaged backend readiness"),
      status("failed", { firstStart: true, elapsedMs: 300_000 }),
      0,
    );
    expect(report).toContain("modus did not start (after 5 min)");
    expect(report).toContain("modus desktop 0.3.7, first start");
    expect(report).toContain("starting the engine (failed)");
    expect(report).toContain("reason: the modus engine did not become ready in time.");
    expect(report).toContain("log: C:\\Users\\person\\.modus\\logs\\desktop-backend.log");
  });
});

describe("startup screen rendering", () => {
  test("the progress panel shows every step, the time on the current one, and the bar position", () => {
    const html = renderToStaticMarkup(createElement(StartupProgressPanel, {
      view: backend("loading", { lines: ["[secrets] Created secrets file"] }, 8_000),
    }));
    expect(html).toContain("startup-step--done");
    expect(html).toContain("startup-step--current");
    expect(html).toContain("8 s");
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain("width:25%");
    expect(html).toContain("[secrets] Created secrets file");
    expect(html).not.toContain("stop waiting");
  });

  test("a long wait offers to stop, and stopping calls back", () => {
    let stopped = 0;
    const tree = StartupProgressPanel({ view: backend("launching", {}, 70_000), onStop: () => { stopped += 1; } });
    const stop = elements(tree).find((element) => element.type === "button");
    expect(stop).toBeDefined();
    (stop!.props as { onClick: () => void }).onClick();
    expect(stopped).toBe(1);
  });

  test("the failure panel offers try again, copy, and the log only when there is one", () => {
    const calls: string[] = [];
    const failure = describeFailure(failed("packaged backend exited before readiness (exit code: 1)"), null, 0);
    const buttons = (onShowLog?: () => void) => elements(StartupFailurePanel({
      failure,
      onRetry: () => calls.push("retry"),
      onCopy: () => calls.push("copy"),
      onShowLog,
      onOtherConnections: () => calls.push("other"),
    })).filter((element) => element.type === "button");

    const withLog = buttons(() => calls.push("log"));
    expect(withLog.map((button) => (button.props as { children: ReactNode }).children)).toEqual([
      "try again",
      "copy details",
      "show log",
      "connect to another modus instead",
    ]);
    for (const button of withLog) (button.props as { onClick: () => void }).onClick();
    expect(calls).toEqual(["retry", "copy", "log", "other"]);
    expect(buttons().map((button) => (button.props as { children: ReactNode }).children)).not.toContain("show log");

    const html = renderToStaticMarkup(createElement(StartupFailurePanel, { failure, onRetry: () => {}, onCopy: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("modus did not start");
    expect(html).toContain("exit code: 1");
  });

  test("the store hands each stage to the screen", () => {
    const store = createStartupStore("work");
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get().stage.kind));
    store.setStatus(status("loading"));
    store.setStage({ kind: "connecting" });
    store.setStage({ kind: "opening" });
    unsubscribe();
    store.setStage({ kind: "failed", during: "connecting", error: "late" });
    expect(seen).toEqual(["backend", "connecting", "opening"]);
    expect(store.vault).toBe("work");
    expect(store.get().status?.phase).toBe("loading");
  });
});

describe("first paint", () => {
  const indexHtml = readFileSync(join(import.meta.dir, "..", "..", "ui", "index.html"), "utf8");
  const style = indexHtml.slice(indexHtml.indexOf("<style>"), indexHtml.indexOf("</style>"));
  const root = indexHtml.slice(indexHtml.indexOf('<div id="root">'), indexHtml.indexOf("<script"));

  test("the page paints the startup splash before any script runs", () => {
    expect(root).toContain('class="startup-screen"');
    expect(root).toContain("startup-mark--working");
    expect(root).toContain("startup-bar-travel");
    expect(root).toContain("starting modus");
  });

  test("every startup class the React screens use is styled in index.html", () => {
    const failure = describeFailure(failed("x"), status("failed"), 0);
    const markup = [
      renderToStaticMarkup(createElement(StartupSplash, { title: "opening modus" })),
      renderToStaticMarkup(createElement(StartupProgressPanel, {
        view: backend("loading", { lines: ["line"], firstStart: true }, 90_000),
        onStop: () => {},
      })),
      renderToStaticMarkup(createElement(StartupFailurePanel, {
        failure, onRetry: () => {}, onCopy: () => {}, onShowLog: () => {}, onOtherConnections: () => {},
      })),
    ].join("");
    const classes = new Set([...markup.matchAll(/class="([^"]+)"/g)]
      .flatMap((match) => match[1].split(/\s+/))
      .filter((name) => name.startsWith("startup-")));
    expect(classes.size).toBeGreaterThan(10);
    const unstyled = [...classes].filter((name) => !style.includes(`.${name}`));
    expect(unstyled).toEqual([]);
  });
});
