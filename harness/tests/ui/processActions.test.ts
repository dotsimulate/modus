import { describe, expect, mock, test } from "bun:test";
import { createPageStateBus } from "../../ui/src/components/pageScope";
import { canOpenProcess, killNeedsConfirm, openProcessSession } from "../../ui/src/widgets/process-actions";

describe("opening a process's session", () => {
  test("a scope adopts the selection and the page stays put", () => {
    const bus = createPageStateBus({ sessionId: null });
    // What ScopeSelectSessionIntentBridge registers on every scope node.
    bus.on("select-session", (event) => bus.set("sessionId", event.sessionId));
    const activateSession = mock((_id: string) => {});
    const onSelectSession = mock((_id: string) => {});

    openProcessSession("ses-1", { emit: bus.emit, get: bus.get, activateSession }, onSelectSession);

    expect(bus.get("sessionId")).toBe("ses-1");
    expect(activateSession).not.toHaveBeenCalled();
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  test("a page without a scope has no listener, so the session opens in chat", () => {
    const bus = createPageStateBus({});
    const activateSession = mock((_id: string) => {});
    const onSelectSession = mock((_id: string) => {});

    openProcessSession("ses-1", { emit: bus.emit, get: bus.get, activateSession }, onSelectSession);

    expect(activateSession).toHaveBeenCalledWith("ses-1");
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  test("a page bus holding a different session is not mistaken for a scope", () => {
    const bus = createPageStateBus({ sessionId: "ses-other" });
    const activateSession = mock((_id: string) => {});

    openProcessSession("ses-1", { emit: bus.emit, get: bus.get, activateSession }, () => {});

    expect(activateSession).toHaveBeenCalledWith("ses-1");
  });

  test("the host callback is the fallback when the page offers no activation", () => {
    const bus = createPageStateBus({});
    const onSelectSession = mock((_id: string) => {});

    openProcessSession("ses-1", { emit: bus.emit, get: bus.get }, onSelectSession);

    expect(onSelectSession).toHaveBeenCalledWith("ses-1");
  });

  test("outside any page the host callback navigates", () => {
    const onSelectSession = mock((_id: string) => {});

    openProcessSession("ses-1", undefined, onSelectSession);

    expect(onSelectSession).toHaveBeenCalledWith("ses-1");
  });

  test("stranded OS processes have no session to open", () => {
    expect(canOpenProcess({ id: "os:1234" })).toBe(false);
    expect(canOpenProcess({ id: "11111111-1111-4111-8111-111111111111" })).toBe(true);
  });
});

describe("kill confirmation", () => {
  test.each(["starting", "running", "paused"])("%s is working, so it asks first", (status) => {
    expect(killNeedsConfirm({ status })).toBe(true);
  });

  test.each(["idle", "done", "error", "orphaned", "interrupting"])("%s has nothing to lose, so it kills directly", (status) => {
    expect(killNeedsConfirm({ status })).toBe(false);
  });
});
