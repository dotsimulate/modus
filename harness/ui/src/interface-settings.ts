import type { ChatScrollIndicator, ConversationLensId, UserInterfaceConfig } from "../../sdk/index";
import { backendStorageKey } from "./backendTarget";

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
    scrollIndicator: ChatScrollIndicator;
    /** Requested open-world lens id. Registry resolution happens at render time. */
    lensId: ConversationLensId;
    scrollThroughTurns: boolean;
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
export const DEVICE_INTERFACE_SETTINGS_STORAGE_KEY = "mo-interface-defaults";
export const INTERFACE_SETTINGS_EVENT = "mo-interface-settings-change";

/**
 * Display fields that may be promoted from the device default into one project.
 * Keeping the list here makes adding a future eligible field an explicit,
 * reviewable choice rather than making every interface preference project-owned.
 */
export const PROJECT_CHAT_OVERRIDE_KEYS = [
  "fontScale",
  "chatWidth",
  "scrollIndicator",
  "lensId",
  "scrollThroughTurns",
] as const satisfies readonly (keyof ResolvedInterfaceSettings["chat"])[];

export const DEFAULT_INTERFACE_SETTINGS: ResolvedInterfaceSettings = {
  chat: {
    fontScale: 100,
    chatWidth: 840,
    scrollIndicator: "spine",
    lensId: "core:transcript",
    scrollThroughTurns: false,
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

export const CHAT_SCROLL_INDICATORS = [
  { value: "scroll", label: "scroll" },
  { value: "spine", label: "spine" },
  { value: "ruler", label: "ruler" },
] as const;

export const CORE_CONVERSATION_LENSES = [
  { value: "core:transcript", label: "Transcript" },
  { value: "core:focus", label: "Focus" },
] as const;

/**
 * `spineEnabled` was a boolean before there were three indicators. An explicit
 * `scrollIndicator` always wins; otherwise a stored `spineEnabled: false`
 * still means "no spine", so an existing profile keeps the choice it made.
 */
function resolveScrollIndicator(chat?: UserInterfaceConfig["chat"]): ChatScrollIndicator {
  const explicit = chat?.scrollIndicator;
  if (explicit === "scroll" || explicit === "spine" || explicit === "ruler") return explicit;
  if (chat?.spineEnabled === false) return "scroll";
  return DEFAULT_INTERFACE_SETTINGS.chat.scrollIndicator;
}

export function legacyPresentationLensId(value: unknown): ConversationLensId | null {
  if (value === "conversation") return "core:transcript";
  if (value === "turns") return "core:focus";
  return null;
}

/**
 * Preserve authored ids verbatim enough to explain a fallback later. This is
 * intentionally not a closed-set sanitizer: registry discovery owns whether
 * an id is available, while settings own what the user requested.
 */
export function resolveRequestedLensId(
  value: unknown,
  legacyPresentation: unknown,
  fallback: ConversationLensId,
): ConversationLensId {
  if (typeof value === "string" && value.trim()) return value.trim();
  return legacyPresentationLensId(legacyPresentation) ?? fallback;
}

export function resolveInterfaceSettings(config?: UserInterfaceConfig | null): ResolvedInterfaceSettings {
  const toolCalls = config?.conversation?.toolCalls;
  return {
    chat: {
      fontScale: finiteRange(config?.chat?.fontScale, DEFAULT_INTERFACE_SETTINGS.chat.fontScale, 75, 175),
      chatWidth: finiteRange(config?.chat?.chatWidth, DEFAULT_INTERFACE_SETTINGS.chat.chatWidth, 500, 1600),
      scrollIndicator: resolveScrollIndicator(config?.chat),
      lensId: resolveRequestedLensId(
        config?.chat?.lensId,
        config?.chat?.presentation,
        DEFAULT_INTERFACE_SETTINGS.chat.lensId,
      ),
      scrollThroughTurns: config?.chat?.scrollThroughTurns === true,
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

function parseInterfaceSettings(raw: string): ResolvedInterfaceSettings {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // Migrate the old flat chat-only shape while accepting the current shape.
  const config: UserInterfaceConfig = "chat" in parsed || "conversation" in parsed
    ? parsed as UserInterfaceConfig
    : {
        chat: {
          fontScale: parsed.fontScale as number | undefined,
          chatWidth: parsed.chatWidth as number | undefined,
          scrollIndicator: parsed.scrollIndicator as ChatScrollIndicator | undefined,
          lensId: parsed.lensId as string | undefined,
          presentation: parsed.presentation as "conversation" | "turns" | undefined,
          spineEnabled: parsed.spineEnabled as boolean | undefined,
        },
      };
  return resolveInterfaceSettings(config);
}

/** Device-owned defaults, isolated from other backend/Vault targets. */
export function readDeviceInterfaceSettings(): ResolvedInterfaceSettings {
  try {
    const storageKey = backendStorageKey(DEVICE_INTERFACE_SETTINGS_STORAGE_KEY);
    const raw = localStorage.getItem(storageKey)
      ?? localStorage.getItem(backendStorageKey(INTERFACE_SETTINGS_STORAGE_KEY))
      ?? (backendStorageKey(INTERFACE_SETTINGS_STORAGE_KEY) !== INTERFACE_SETTINGS_STORAGE_KEY
        ? localStorage.getItem(INTERFACE_SETTINGS_STORAGE_KEY)
        : null);
    if (raw) {
      const settings = parseInterfaceSettings(raw);
      // Snapshot the legacy cache before an active project override can replace
      // it, so the migration preserves what the user last saw as their default.
      if (!localStorage.getItem(storageKey)) {
        localStorage.setItem(storageKey, JSON.stringify(settings));
      }
      return settings;
    }
  } catch {
    // A malformed client cache must never prevent the UI from starting.
  }
  return resolveInterfaceSettings();
}

export function writeDeviceInterfaceSettings(settings: ResolvedInterfaceSettings): void {
  localStorage.setItem(
    backendStorageKey(DEVICE_INTERFACE_SETTINGS_STORAGE_KEY),
    JSON.stringify(settings),
  );
}

export function projectChatOverrideEnabled(config?: UserInterfaceConfig | null): boolean {
  return config?.chat?.projectOverride === true;
}

export function projectChatOverrideConfig(
  settings: ResolvedInterfaceSettings,
): NonNullable<UserInterfaceConfig["chat"]> {
  return {
    projectOverride: true,
    fontScale: settings.chat.fontScale,
    chatWidth: settings.chat.chatWidth,
    scrollIndicator: settings.chat.scrollIndicator,
    lensId: settings.chat.lensId,
    scrollThroughTurns: settings.chat.scrollThroughTurns,
  };
}

/** Build the persisted project chat object without carrying the legacy enum forward. */
export function writableProjectChatConfig(
  existing: UserInterfaceConfig["chat"] | undefined,
  settings: ResolvedInterfaceSettings,
): NonNullable<UserInterfaceConfig["chat"]> {
  const { presentation: _legacyPresentation, ...current } = existing ?? {};
  return { ...current, ...projectChatOverrideConfig(settings) };
}

/** Apply the explicit project display override over this device's defaults. */
export function resolveEffectiveInterfaceSettings(
  projectConfig?: UserInterfaceConfig | null,
  deviceDefaults: ResolvedInterfaceSettings = readDeviceInterfaceSettings(),
): ResolvedInterfaceSettings {
  if (!projectChatOverrideEnabled(projectConfig)) return deviceDefaults;
  const chat = projectConfig?.chat;
  return {
    ...deviceDefaults,
    chat: {
      fontScale: finiteRange(chat?.fontScale, deviceDefaults.chat.fontScale, 75, 175),
      chatWidth: finiteRange(chat?.chatWidth, deviceDefaults.chat.chatWidth, 500, 1600),
      scrollIndicator: chat?.scrollIndicator === "scroll"
        || chat?.scrollIndicator === "spine"
        || chat?.scrollIndicator === "ruler"
        ? chat.scrollIndicator
        : deviceDefaults.chat.scrollIndicator,
      lensId: resolveRequestedLensId(chat?.lensId, chat?.presentation, deviceDefaults.chat.lensId),
      scrollThroughTurns: typeof chat?.scrollThroughTurns === "boolean"
        ? chat.scrollThroughTurns
        : deviceDefaults.chat.scrollThroughTurns,
    },
  };
}

/** Last effective value for non-React consumers such as session history loading. */
export function readLocalInterfaceSettings(): ResolvedInterfaceSettings {
  try {
    const raw = localStorage.getItem(backendStorageKey(INTERFACE_SETTINGS_STORAGE_KEY));
    if (raw) return parseInterfaceSettings(raw);
  } catch {
    // Fall through to device defaults.
  }
  return readDeviceInterfaceSettings();
}

export function applyInterfaceSettings(settings: ResolvedInterfaceSettings): void {
  const root = document.documentElement;
  root.style.setProperty("--chat-max-width", `${settings.chat.chatWidth}px`);
  root.style.setProperty("--font-scale", `${settings.chat.fontScale / 100}`);
  root.dataset.reducedMotion = settings.motion === "reduced" ? "true" : "false";
  localStorage.setItem(backendStorageKey(INTERFACE_SETTINGS_STORAGE_KEY), JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent(INTERFACE_SETTINGS_EVENT, { detail: settings }));
}

export function resetClientInterfaceState(): void {
  const exactKeys = new Set([
    backendStorageKey(INTERFACE_SETTINGS_STORAGE_KEY),
    backendStorageKey(DEVICE_INTERFACE_SETTINGS_STORAGE_KEY),
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
  const defaults = resolveInterfaceSettings();
  writeDeviceInterfaceSettings(defaults);
  applyInterfaceSettings(defaults);
}

// Preserve the old eager behavior so chat sizing is correct before React mounts.
if (typeof document !== "undefined") applyInterfaceSettings(readDeviceInterfaceSettings());
