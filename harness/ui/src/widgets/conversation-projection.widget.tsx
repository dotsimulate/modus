import { Component, useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import type {
  ConversationProjectionPropsV1,
  ConversationProjectionTurnV1,
  SessionTurnIndex,
} from "../../../sdk/index";
import { BACKEND_TARGET, backendUrl } from "../backendTarget";
import {
  buildConversationProjectionTurns,
  conversationProjectionIsPartial,
} from "../conversation-projection-data";
import {
  evictAuthoredComponent,
  loadAuthoredComponent,
} from "../components/authored-component-loader";
import { modus } from "../modusClient";
import {
  ensureSubscribed,
  loadOlderSessionHistory,
  loadSessionMessageDetails,
  useSessionHistoryLoadState,
  useSessionState,
} from "../sessionStore";
import { useConversationResources } from "../useConversationResources";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type ConversationProjectionConfig = WidgetBase & {
  type: "conversation-projection";
  projectionId: string;
  sessionId?: string;
};

function reportProjectionFailure(sessionId: string, lensId: string, reason: string): void {
  window.dispatchEvent(new CustomEvent("modus:conversation-projection-error", {
    detail: { sessionId, lensId, reason },
  }));
}

class ProjectionErrorBoundary extends Component<{
  sessionId: string;
  lensId: string;
  onError: (reason: string) => void;
  children: ReactNode;
}, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error instanceof Error ? error.message : String(error));
  }

  render() {
    return this.state.error
      ? <div className="conversation-projection-error">projection failed · {this.state.error}</div>
      : this.props.children;
  }
}

export default function ConversationProjectionWidget({ config, pageContext }: WidgetProps<ConversationProjectionConfig>) {
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const selectedSession = pageContext?.get("selectedSession") as string | undefined;
  const sessionId = contextSessionId ?? selectedSession ?? config.sessionId ?? null;
  const session = useSessionState(sessionId);
  const history = useSessionHistoryLoadState(sessionId);
  // Resolve against the exact project registry chosen by the host. Sessions
  // created without a cwd still belong to the active conversation project;
  // falling back to session.cwd alone would make that project's projection
  // disappear inside an otherwise-valid lens.
  const contextCwd = pageContext?.get("conversationCwd");
  const cwd = typeof contextCwd === "string" && contextCwd ? contextCwd : (session?.cwd ?? null);
  const resources = useConversationResources(cwd);
  const lensId = String(pageContext?.get("conversationLensId") ?? "unknown");
  const rawSelectedTurn = pageContext?.get("turnNumber");
  const selectedTurnNumber = typeof rawSelectedTurn === "number" ? rawSelectedTurn : null;
  const [index, setIndex] = useState<SessionTurnIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [ComponentImpl, setComponentImpl] = useState<ComponentType<ConversationProjectionPropsV1> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const messageCount = session?.messages.length ?? 0;
  useEffect(() => {
    if (!sessionId) {
      setIndex(null);
      return;
    }
    const controller = new AbortController();
    let active = true;
    modus.getSessionTurnIndex(sessionId, { signal: controller.signal })
      .then((next) => {
        if (active) {
          setIndex(next);
          setIndexError(null);
        }
      })
      .catch((error) => {
        if (active && !controller.signal.aborted) {
          setIndexError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [messageCount, sessionId]);

  const projection = resources.registry?.projections.find((entry) => entry.id === config.projectionId);
  const moduleUrl = projection?.moduleUrl ? backendUrl(projection.moduleUrl) : null;

  useEffect(() => {
    setComponentImpl(null);
    setLoadError(null);
    if (!sessionId || !projection || projection.status !== "available" || !projection.definition || !moduleUrl) {
      if (resources.status === "ready") {
        const reason = projection?.reason ?? `projection ${config.projectionId} is unavailable`;
        setLoadError(reason);
        reportProjectionFailure(sessionId ?? "", lensId, reason);
      }
      return;
    }
    if (BACKEND_TARGET.mode === "remote") {
      const reason = "authored projection code is disabled for remote backends";
      setLoadError(reason);
      reportProjectionFailure(sessionId, lensId, reason);
      return;
    }
    if (projection.definition.cache === "none") evictAuthoredComponent(moduleUrl);
    let active = true;
    loadAuthoredComponent<ConversationProjectionPropsV1>(moduleUrl, "Projection", "Conversation projection")
      .then((component) => {
        if (active) setComponentImpl(() => component);
      })
      .catch((error) => {
        if (!active) return;
        const reason = error instanceof Error ? error.message : String(error);
        setLoadError(reason);
        reportProjectionFailure(sessionId, lensId, reason);
      });
    return () => {
      active = false;
      if (projection.definition?.cache === "none") evictAuthoredComponent(moduleUrl);
    };
  }, [config.projectionId, lensId, moduleUrl, projection, resources.status, sessionId]);

  const turns = useMemo<ConversationProjectionTurnV1[]>(() => {
    return buildConversationProjectionTurns(index, session?.messages ?? [], history.olderTurnCount);
  }, [history.olderTurnCount, index?.turns, session?.messages]);

  const selectTurn = useCallback((number: number, seq: number) => {
    pageContext?.set("turnSessionId", sessionId);
    pageContext?.set("turnNumber", number);
    pageContext?.set("turnSeq", seq);
  }, [pageContext, sessionId]);
  const loadOlder = useCallback(
    () => sessionId ? loadOlderSessionHistory(sessionId) : Promise.resolve(),
    [sessionId],
  );
  const loadDetails = useCallback(
    (seq: number) => sessionId ? loadSessionMessageDetails(sessionId, seq) : Promise.resolve(),
    [sessionId],
  );

  if (!sessionId) return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  if (!session || resources.status === "loading") return <WidgetEmptyState>loading projection…</WidgetEmptyState>;
  if (loadError) return <div className="conversation-projection-error">projection failed · {loadError}</div>;
  if (!projection?.definition || !ComponentImpl) return <WidgetEmptyState>loading projection…</WidgetEmptyState>;

  const projectionProps: ConversationProjectionPropsV1 = {
    contract: "conversation-projection@1",
    projection: {
      id: projection.id,
      label: projection.definition.label,
      source: projection.source,
    },
    session: { id: sessionId, ...(cwd ? { cwd } : {}), status: session.status },
    turns,
    turnIndexSource: index?.source ?? "loaded",
    partial: conversationProjectionIsPartial(index, indexError),
    selectedTurnNumber,
    history: {
      hasMore: history.hasMore,
      loadingOlder: history.loadingOlder,
      olderTurnCount: history.olderTurnCount,
      ...(history.olderError || indexError ? { error: history.olderError ?? indexError ?? undefined } : {}),
    },
    selectTurn,
    loadOlder,
    loadDetails,
  };

  return (
    <ProjectionErrorBoundary
      sessionId={sessionId}
      lensId={lensId}
      onError={(reason) => reportProjectionFailure(sessionId, lensId, reason)}
    >
      <ComponentImpl {...projectionProps} />
    </ProjectionErrorBoundary>
  );
}
