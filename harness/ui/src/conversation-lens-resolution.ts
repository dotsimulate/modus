import type {
  ConversationCapabilityId,
  ConversationCapabilityResolution,
  ConversationLensRegistryEntry,
  ConversationResourceRegistry,
} from "../../sdk/index";

export type ResolvedConversationLens = {
  requestedId: string;
  resolvedId: string | null;
  entry: ConversationLensRegistryEntry | null;
  reason?: string;
  attempts: Array<{ id: string; reason?: string }>;
};

function capabilityFailure(
  entry: ConversationLensRegistryEntry,
  capabilities: Partial<Record<ConversationCapabilityId, ConversationCapabilityResolution>>,
): string | null {
  for (const required of entry.definition?.capabilities?.required ?? []) {
    const resolution = capabilities[required];
    if (!resolution) return `required capability ${required} was not resolved`;
    if (resolution.status === "unavailable" || resolution.status === "disabled") {
      return `${required} is ${resolution.status}${resolution.reason ? `: ${resolution.reason}` : ""}`;
    }
  }
  return null;
}

function entryFailure(
  entry: ConversationLensRegistryEntry | undefined,
  capabilities: Partial<Record<ConversationCapabilityId, ConversationCapabilityResolution>>,
): string | null {
  if (!entry) return "not discovered for this project";
  if (!entry.definition) return entry.reason ?? `resource is ${entry.status}`;
  if (entry.status !== "available" && entry.status !== "degraded") {
    return entry.reason ?? `resource is ${entry.status}`;
  }
  return capabilityFailure(entry, capabilities);
}

/** Open-world selection with an explicit, terminating recovery chain. */
export function resolveConversationLens(
  registry: ConversationResourceRegistry | null,
  requestedId: string,
  defaultId: string,
  capabilities: Partial<Record<ConversationCapabilityId, ConversationCapabilityResolution>>,
): ResolvedConversationLens {
  const entries = new Map((registry?.lenses ?? []).map((entry) => [entry.id, entry]));
  const requested = entries.get(requestedId);
  const requestedFallback = requested
    && (requested.status === "available" || requested.status === "degraded")
    ? requested.definition?.fallback
    : undefined;
  const candidates = [
    requestedId,
    requestedFallback,
    defaultId,
    "core:transcript",
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  const unique = [...new Set(candidates)];
  const attempts: Array<{ id: string; reason?: string }> = [];

  for (const id of unique) {
    const entry = entries.get(id);
    const failure = entryFailure(entry, capabilities);
    attempts.push({ id, ...(failure ? { reason: failure } : {}) });
    if (!failure && entry) {
      const firstFailure = attempts.find((attempt) => attempt.reason);
      return {
        requestedId,
        resolvedId: id,
        entry,
        attempts,
        ...(id !== requestedId && firstFailure
          ? { reason: `${firstFailure.id}: ${firstFailure.reason}; using ${entry.definition?.label ?? id}` }
          : {}),
      };
    }
  }

  const firstFailure = attempts.find((attempt) => attempt.reason);
  return {
    requestedId,
    resolvedId: null,
    entry: null,
    attempts,
    reason: firstFailure
      ? `${firstFailure.id}: ${firstFailure.reason}; Transcript is unavailable`
      : "Transcript is unavailable",
  };
}

export function resolveConversationCapabilities(input: {
  sessionId: string | null;
  historyError?: string | null;
  disabled?: ConversationCapabilityId[];
  unavailable?: Partial<Record<ConversationCapabilityId, string>>;
  degraded?: Partial<Record<ConversationCapabilityId, string>>;
}): Record<ConversationCapabilityId, ConversationCapabilityResolution> {
  const ids: ConversationCapabilityId[] = [
    "conversation.permissions",
    "conversation.turn-content",
    "conversation.turn-index",
    "conversation.compose",
    "conversation.history",
    "conversation.artifacts",
  ];
  const disabled = new Set(input.disabled ?? []);
  return Object.fromEntries(ids.map((id) => {
    let resolution: ConversationCapabilityResolution;
    if (disabled.has(id)) {
      resolution = { status: "disabled", reason: "disabled by current interface policy", version: 1 };
    } else if (input.unavailable?.[id]) {
      resolution = { status: "unavailable", reason: input.unavailable[id], version: 1 };
    } else if (!input.sessionId) {
      resolution = { status: "unavailable", reason: "no session selected", version: 1 };
    } else if (input.degraded?.[id]) {
      resolution = { status: "degraded", reason: input.degraded[id], version: 1 };
    } else if (id === "conversation.history" && input.historyError) {
      resolution = { status: "degraded", reason: input.historyError, version: 1 };
    } else {
      resolution = { status: "available", version: 1 };
    }
    return [id, resolution];
  })) as Record<ConversationCapabilityId, ConversationCapabilityResolution>;
}
