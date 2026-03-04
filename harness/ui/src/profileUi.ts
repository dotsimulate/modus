/**
 * UI-side profile configuration.
 * Server profiles handle SDK options. This handles presentation.
 */

export type ProfileUiConfig = {
  label: string;
  showThinking: boolean;
  showMeta: boolean;
  showToolCalls: boolean;
  placeholder?: string;
  emptyTitle?: string;
  emptySubtitle?: string;
};

const defaults: ProfileUiConfig = {
  label: "agent",
  showThinking: true,
  showMeta: true,
  showToolCalls: true,
  placeholder: "message...",
  emptyTitle: undefined,
  emptySubtitle: "start typing to begin",
};

const configs: Record<string, Partial<ProfileUiConfig>> = {
  "test-harness": {
    label: "test",
    showThinking: true,
    showMeta: true,
    showToolCalls: true,
    placeholder: "test message...",
    emptyTitle: "test-harness",
    emptySubtitle: "haiku / low effort / read-only tools",
  },
  "dev-agent": {
    label: "dev",
    showThinking: true,
    showMeta: true,
    showToolCalls: true,
    placeholder: "what should we build?",
    emptyTitle: "dev-agent",
    emptySubtitle: "opus / full tools / self-learning",
  },
  research: {
    label: "research",
    showThinking: false,
    showMeta: true,
    showToolCalls: true,
    placeholder: "what should I research?",
    emptyTitle: "research",
    emptySubtitle: "sonnet / read-only / web search",
  },
};

export function getProfileUi(name: string): ProfileUiConfig {
  return { ...defaults, ...configs[name] };
}
