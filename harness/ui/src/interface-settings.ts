import type { UserInterfaceConfig } from "../../sdk/index";

export type ResolvedInterfaceSettings = {
  chat: {
    fontScale: number;
    chatWidth: number;
    spineEnabled: boolean;
  };
  conversation: {
    showThinking: boolean;
    showMeta: boolean;
    toolCalls: "expanded" | "collapsed" | "hidden";
    showGitEvents: boolean;
    showFileChanges: boolean;
  };
  motion: "system" | "reduced";
};

export const INTERFACE_SETTINGS_STORAGE_KEY = "mo-chat-settings";
export const INTERFACE_SETTINGS_EVENT = "mo-interface-settings-change";

export const DEFAULT_INTERFACE_SETTINGS: ResolvedInterfaceSettings = {
  chat: {
    fontScale: 100,
    chatWidth: 840,
    spineEnabled: true,
  },
  conversation: {
    showThinking: true,
    showMeta: true,
    toolCalls: "collapsed",
    showGitEvents: false,
    showFileChanges: true,
  },
  motion: "system",
};

function finiteRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

export function resolveInterfaceSettings(config?: UserInterfaceConfig | null): ResolvedInterfaceSettings {
  const toolCalls = config?.conversation?.toolCalls;
  return {
    chat: {
      fontScale: finiteRange(config?.chat?.fontScale, DEFAULT_INTERFACE_SETTINGS.chat.fontScale, 75, 175),
      chatWidth: finiteRange(config?.chat?.chatWidth, DEFAULT_INTERFACE_SETTINGS.chat.chatWidth, 500, 1600),
      spineEnabled: config?.chat?.spineEnabled ?? DEFAULT_INTERFACE_SETTINGS.chat.spineEnabled,
    },
    conversation: {
      showThinking: config?.conversation?.showThinking ?? DEFAULT_INTERFACE_SETTINGS.conversation.showThinking,
      showMeta: config?.conversation?.showMeta ?? DEFAULT_INTERFACE_SETTINGS.conversation.showMeta,
      toolCalls: toolCalls === "expanded" || toolCalls === "hidden" ? toolCalls : "collapsed",
      showGitEvents: config?.conversation?.showGitEvents ?? DEFAULT_INTERFACE_SETTINGS.conversation.showGitEvents,
      showFileChanges: config?.conversation?.showFileChanges ?? DEFAULT_INTERFACE_SETTINGS.conversation.showFileChanges,
    },
    motion: config?.motion === "reduced" ? "reduced" : "system",
  };
}

export function readLocalInterfaceSettings(): ResolvedInterfaceSettings {
  try {
    const raw = localStorage.getItem(INTERFACE_SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Migrate the old flat chat-only shape while accepting the new shape.
      const config: UserInterfaceConfig = "chat" in parsed || "conversation" in parsed
        ? parsed as UserInterfaceConfig
        : {
            chat: {
              fontScale: parsed.fontScale as number | undefined,
              chatWidth: parsed.chatWidth as number | undefined,
              spineEnabled: parsed.spineEnabled as boolean | undefined,
            },
          };
      return resolveInterfaceSettings(config);
    }
  } catch {
    // A malformed client cache must never prevent the UI from starting.
  }
  return resolveInterfaceSettings();
}

export function applyInterfaceSettings(settings: ResolvedInterfaceSettings): void {
  const root = document.documentElement;
  root.style.setProperty("--chat-max-width", `${settings.chat.chatWidth}px`);
  root.style.setProperty("--font-scale", `${settings.chat.fontScale / 100}`);
  root.dataset.reducedMotion = settings.motion === "reduced" ? "true" : "false";
  localStorage.setItem(INTERFACE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent(INTERFACE_SETTINGS_EVENT, { detail: settings }));
}

export function resetClientInterfaceState(): void {
  const exactKeys = new Set([
    INTERFACE_SETTINGS_STORAGE_KEY,
    "ap:expanded",
    "ap:pinned",
    "ap:pos2",
    "modus.git.sidebarWidth",
    "modus.git.detailWidth",
    "chat-file-viewer-bounds",
    "session-window-bounds",
  ]);
  const prefixes = ["harness:widget-ui:", "harness:editable-panel:"];
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (key && (exactKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))) {
      localStorage.removeItem(key);
    }
  }
  applyInterfaceSettings(resolveInterfaceSettings());
}

// Preserve the old eager behavior so chat sizing is correct before React mounts.
if (typeof document !== "undefined") applyInterfaceSettings(readLocalInterfaceSettings());
