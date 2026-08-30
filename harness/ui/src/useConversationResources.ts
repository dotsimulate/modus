import { useEffect, useState } from "react";
import type { ConversationResourceRegistry } from "../../sdk/index";
import { subscribeBrowserResume } from "./browser-resume";
import { modus } from "./modusClient";

export type ConversationResourcesState = {
  status: "idle" | "loading" | "ready" | "error";
  discoveredFor: string | null;
  registry: ConversationResourceRegistry | null;
  error?: string;
};

export function useConversationResources(cwd?: string | null): ConversationResourcesState {
  const [state, setState] = useState<ConversationResourcesState>({
    status: cwd ? "loading" : "idle",
    discoveredFor: null,
    registry: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!cwd) {
      setState({ status: "idle", discoveredFor: null, registry: null });
      return;
    }
    const controller = new AbortController();
    let active = true;
    // A retry must not tear down a settled result for the same project: the host
    // renders a wait for `loading`, so resetting here would blank a conversation
    // that is already recovering through the emergency registry.
    setState((prev) => (prev.discoveredFor === cwd
      ? prev
      : { status: "loading", discoveredFor: null, registry: null }));
    modus.listConversationResources(cwd, { signal: controller.signal })
      .then((registry) => {
        if (active) setState({ status: "ready", discoveredFor: cwd, registry });
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setState({
          status: "error",
          discoveredFor: cwd,
          registry: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [cwd, attempt]);

  // Discovery runs once per project, so a request that never settles strands
  // every conversation in that project until the cwd changes. A backgrounded
  // mobile browser can hold a fetch open without resolving or rejecting it, so
  // returning to the foreground re-issues the request instead of waiting.
  const settled = state.status === "ready" && state.discoveredFor === cwd;
  useEffect(() => {
    if (!cwd || settled) return;
    return subscribeBrowserResume(() => setAttempt((value) => value + 1));
  }, [cwd, settled]);

  // The cwd changes in render before the effect above can clear state. Never
  // expose the outgoing project's registry during that one render; identity
  // markers, not boolean loaded flags, make discovery race-safe.
  if (cwd && state.discoveredFor !== cwd) {
    return { status: "loading", discoveredFor: null, registry: null };
  }
  return state;
}
