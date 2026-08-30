import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { subscribeBrowserResume } from "../../ui/src/browser-resume";

class ResumeWindow extends EventTarget {}

class ResumeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

describe("browser resume", () => {
  test("signals foreground, page restore, focus, and network recovery", () => {
    const windowTarget = new ResumeWindow();
    const documentTarget = new ResumeDocument();
    let now = 1_000;
    let resumes = 0;
    const unsubscribe = subscribeBrowserResume(() => { resumes++; }, {
      windowTarget,
      documentTarget,
      now: () => now,
      dedupeMs: 250,
    });

    documentTarget.dispatchEvent(new Event("visibilitychange"));
    now += 300;
    windowTarget.dispatchEvent(new Event("pageshow"));
    now += 300;
    windowTarget.dispatchEvent(new Event("focus"));
    now += 300;
    windowTarget.dispatchEvent(new Event("online"));

    expect(resumes).toBe(4);
    unsubscribe();
  });

  test("ignores hidden signals, coalesces a foreground event burst, and cleans up", () => {
    const windowTarget = new ResumeWindow();
    const documentTarget = new ResumeDocument();
    let now = 5_000;
    let resumes = 0;
    const unsubscribe = subscribeBrowserResume(() => { resumes++; }, {
      windowTarget,
      documentTarget,
      now: () => now,
      dedupeMs: 250,
    });

    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(resumes).toBe(0);

    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(resumes).toBe(1);

    unsubscribe();
    now += 300;
    windowTarget.dispatchEvent(new Event("online"));
    expect(resumes).toBe(1);
  });

  test("wires resume to both session index and transcript stream recovery", () => {
    const provider = readFileSync(
      resolve(import.meta.dir, "../../ui/src/providers/SessionProvider.tsx"),
      "utf8",
    );
    const effect = provider.match(/subscribeBrowserResume\(\(\) => \{([\s\S]*?)\}\)/)?.[1] ?? "";

    expect(effect).toContain("resumeSessionIndex()");
    expect(effect).toContain("resumeSessionEventStreams()");
  });
});
