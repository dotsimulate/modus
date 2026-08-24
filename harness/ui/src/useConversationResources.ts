import { useEffect, useState } from "react";
import type { ConversationResourceRegistry } from "../../sdk/index";
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

  useEffect(() => {
    if (!cwd) {
      setState({ status: "idle", discoveredFor: null, registry: null });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setState({ status: "loading", discoveredFor: null, registry: null });
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
  }, [cwd]);

  // The cwd changes in render before the effect above can clear state. Never
  // expose the outgoing project's registry during that one render; identity
  // markers, not boolean loaded flags, make discovery race-safe.
  if (cwd && state.discoveredFor !== cwd) {
    return { status: "loading", discoveredFor: null, registry: null };
  }
  return state;
}
