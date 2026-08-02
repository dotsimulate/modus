import type { UserInterfaceConfig } from "../../sdk/index";

/**
 * Everything the session config bar can show, in the order it appears.
 *
 * The bar is narrow and every provider adds its own controls to it, so which
 * items earn their space is a preference rather than a fixed layout. This list
 * is the single source for both the bar and the settings picker — adding an
 * entry here is all a new readout needs to become selectable.
 *
 * The Claude permission-mode badge is deliberately absent: it only appears when
 * the session is in a non-default permission mode, and that is a safety signal,
 * not a decoration to switch off.
 */
export const CONFIG_BAR_ITEMS = [
  { id: "profile", label: "profile" },
  { id: "model", label: "model" },
  { id: "tools", label: "tools" },
  { id: "controls", label: "provider controls" },
  { id: "effort", label: "effort" },
  { id: "context", label: "context %" },
  { id: "cost", label: "cost" },
  { id: "tokens", label: "tokens" },
  { id: "overrides", label: "overrides" },
] as const;

export type ConfigBarItemId = (typeof CONFIG_BAR_ITEMS)[number]["id"];

const DEFAULT_CONFIG_BAR_ITEMS: ConfigBarItemId[] = [
  "profile", "model", "tools", "controls", "effort", "context", "overrides",
];

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
    /**
     * Let the harness withhold very large tool payloads until asked. Turning
     * this off is reasonable here — the transport is localhost, and the real
     * cost is browser memory on a long session rather than bandwidth.
     */
    deferHeavyDetails: boolean;
  };
  configBar: {
    items: ConfigBarItemId[];
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
    deferHeavyDetails: true,
  },
  configBar: {
    items: DEFAULT_CONFIG_BAR_ITEMS,
  },
  motion: "system",
};

function finiteRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

/**
 * An explicit empty list means "show nothing", so only a missing or malformed
 * value falls back to the defaults. Unknown ids are dropped rather than
 * rejected, which is what lets an older config survive a renamed item.
 */
function resolveConfigBarItems(raw: unknown): ConfigBarItemId[] {
  if (!Array.isArray(raw)) return DEFAULT_CONFIG_BAR_ITEMS;
  const chosen = new Set(raw.filter((value): value is string => typeof value === "string"));
  // Catalog order wins, so the bar reads the same however the list was written.
  return CONFIG_BAR_ITEMS.filter((item) => chosen.has(item.id)).map((item) => item.id);
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
      deferHeavyDetails: config?.conversation?.deferHeavyDetails ?? DEFAULT_INTERFACE_SETTINGS.conversation.deferHeavyDetails,
    },
    configBar: {
      items: resolveConfigBarItems(config?.configBar?.items),
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
