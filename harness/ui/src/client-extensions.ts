import { useSyncExternalStore, useMemo } from "react";
import { API_BASE, authHeaders } from "./modusClient";
import type { ClientExtensionManifestItem, MoveListItem } from "../../sdk/index";

type ComposerSnapshot = {
  sessionId?: string;
  cwd?: string;
  userProfile?: string;
  draft: string;
};

type ComposerHandle = {
  id: string;
  getSnapshot: () => ComposerSnapshot;
  focus: () => void;
  setDraft: (text: string) => void;
  insertText: (text: string) => void;
  setGhostText: (text: string | null) => void;
  submit: (text?: string) => void;
  /** Attach a move as a chip above the textarea. Optional — older composers may not support it. */
  attachMove?: (move: MoveListItem, inputs: Record<string, unknown>) => void;
};

type PendingAttach = { move: MoveListItem; inputs: Record<string, unknown> };

type ComposerTarget = Omit<ComposerHandle, "id">;

type ShortcutHandler = (ctx: {
  event: KeyboardEvent;
  getComposer: () => ComposerTarget | null;
}) => void | Promise<void>;

type ComposerActionIcon = "mic" | "mic-handsfree";

/** "warning" is the advisory middle: working, but not well — a live recording
 *  that is too quiet to transcribe, say. Without it such states had to pick
 *  between "active" (invisible advice) and "error" (a fault that is not one),
 *  and they kept picking error. */
type ComposerActionStatusTone = "default" | "active" | "busy" | "error" | "gated" | "warning";
type ComposerToggleTone = "default" | "active" | "busy" | "error";

type ComposerActionState = {
  label?: string;
  title?: string;
  icon?: ComposerActionIcon;
  disabled?: boolean;
  status?: {
    label: string;
    tone?: ComposerActionStatusTone;
  } | null;
};

type ComposerActionHandler = (ctx: {
  composer: ComposerTarget | null;
}) => void | Promise<void>;

type ComposerActionConfig = ComposerActionState & {
  id?: string;
  order?: number;
  onClick: ComposerActionHandler;
};

type RegisteredComposerAction = {
  update: (next: Partial<ComposerActionState>) => void;
  unregister: () => void;
};

type ComposerToggleState = {
  label: string;
  title?: string;
  enabled?: boolean;
  busy?: boolean;
  disabled?: boolean;
  tone?: ComposerToggleTone;
};

type ComposerToggleHandler = (ctx: {
  composer: ComposerTarget | null;
  enabled: boolean;
}) => void | Promise<void>;

type ComposerToggleConfig = ComposerToggleState & {
  id?: string;
  order?: number;
  onToggle: ComposerToggleHandler;
};

type RegisteredComposerToggle = {
  update: (next: Partial<ComposerToggleState>) => void;
  unregister: () => void;
};

export type ExtensionSettingOption = { value: string; label: string };

type SettingOptionsConfig = {
  options: ExtensionSettingOption[];
  /** Label for the "leave unset" choice. Omit to require an explicit value. */
  emptyLabel?: string;
};

type RegisteredSetting = {
  update: (next: Partial<SettingOptionsConfig>) => void;
  unregister: () => void;
};

type ClientExtensionApi = {
  registerShortcut: (binding: string, handler: ShortcutHandler) => () => void;
  registerComposerAction: (config: ComposerActionConfig) => RegisteredComposerAction;
  registerComposerToggle: (config: ComposerToggleConfig) => RegisteredComposerToggle;
  /**
   * Publish a live option list for one of this extension's declared settings.
   * The sidecar manifest can only express static options, but some choices —
   * audio devices being the motivating case — only exist in the browser. The
   * settings UI renders these as a dropdown while the extension is loaded and
   * falls back to the manifest's declared field when it is not.
   */
  registerSetting: (name: string, config: SettingOptionsConfig) => RegisteredSetting;
  getComposer: () => ComposerSnapshot | null;
  setDraft: (text: string) => void;
  insertText: (text: string) => void;
  setGhostText: (text: string | null) => void;
  focusComposer: () => void;
  submitComposer: (text?: string) => void;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  getSettings: () => Record<string, unknown>;
};

type ClientExtensionDefinition =
  | ((api: ClientExtensionApi) => void | (() => void) | Promise<void | (() => void)>)
  | {
      onLoad?: (api: ClientExtensionApi) => void | (() => void) | Promise<void | (() => void)>;
    };

type LoadedExtension = {
  id: string;
  cleanup?: () => void;
};

type ShortcutRegistration = {
  id: string;
  binding: ShortcutBinding;
  handler: ShortcutHandler;
};

type ComposerActionRegistration = {
  key: string;
  extensionId: string;
  order: number;
  state: ComposerActionState;
  onClick: ComposerActionHandler;
};

export type ComposerActionView = ComposerActionState & {
  key: string;
  extensionId: string;
  perform: () => Promise<void>;
};

type ComposerToggleRegistration = {
  key: string;
  extensionId: string;
  order: number;
  state: ComposerToggleState;
  onToggle: ComposerToggleHandler;
};

export type ComposerToggleView = ComposerToggleState & {
  key: string;
  extensionId: string;
  toggle: () => Promise<void>;
};

type ShortcutBinding = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

const composers = new Map<string, ComposerHandle>();
/** Attaches queued for composers that haven't registered yet (race-free session creation). */
const pendingAttaches = new Map<string, PendingAttach>();
/** Draft text queued for composers that haven't registered yet. Same race, different payload. */
const pendingDrafts = new Map<string, string>();
let activeComposerId: string | null = null;
const shortcuts: ShortcutRegistration[] = [];
const composerActions = new Map<string, ComposerActionRegistration>();
const composerToggles = new Map<string, ComposerToggleRegistration>();
/** Live setting options, keyed `${extensionId}:${settingName}`. */
const settingOptions = new Map<string, SettingOptionsConfig>();
const loadedExtensions: LoadedExtension[] = [];
let loadedManifestKey: string | null = null;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function extensionManifestKey(items: ClientExtensionManifestItem[]): string {
  return stableJson(items.filter((item) => item.enabled).map((item) => ({
    id: item.id,
    // Project extensions can resolve to a different file at the same route, so
    // their cwd-bearing URL is part of identity. Built-in/global/plugin modules
    // are the same file across projects; only their resolved settings matter.
    moduleUrl: item.source === "project" ? item.moduleUrl : item.moduleUrl.replace(/\?.*$/, ""),
    source: item.source,
    pluginId: item.pluginId,
    pluginPath: item.pluginPath,
    fileName: item.fileName,
    settingsValues: item.settingsValues,
  })));
}
let listenerAttached = false;
const composerControlListeners = new Set<() => void>();
let composerControlSnapshot = 0;

function notifyComposerControls() {
  composerControlSnapshot++;
  for (const listener of composerControlListeners) listener();
}

function subscribeComposerControls(listener: () => void): () => void {
  composerControlListeners.add(listener);
  return () => composerControlListeners.delete(listener);
}

function getComposerControlsSnapshot(): number {
  return composerControlSnapshot;
}

function normalizeKeyPart(part: string): string {
  const lower = part.toLowerCase();
  if (lower === "mod") return navigator.platform.toLowerCase().includes("mac") ? "meta" : "ctrl";
  if (lower === "cmd" || lower === "meta") return "meta";
  if (lower === "control" || lower === "ctrl") return "ctrl";
  if (lower === "option" || lower === "alt") return "alt";
  if (lower === "shift") return "shift";
  if (part.length === 1) return part.toLowerCase();
  return lower;
}

function parseShortcut(binding: string): ShortcutBinding {
  const parts = binding.split("+").map((part) => normalizeKeyPart(part.trim())).filter(Boolean);
  const key = parts.find((part) => !["ctrl", "meta", "alt", "shift"].includes(part));
  if (!key) throw new Error(`shortcut binding requires a key: ${binding}`);
  return {
    key,
    ctrl: parts.includes("ctrl"),
    meta: parts.includes("meta"),
    alt: parts.includes("alt"),
    shift: parts.includes("shift"),
  };
}

function eventKey(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
}

function matchesShortcut(binding: ShortcutBinding, event: KeyboardEvent): boolean {
  return (
    eventKey(event) === binding.key
    && event.ctrlKey === binding.ctrl
    && event.metaKey === binding.meta
    && event.altKey === binding.alt
    && event.shiftKey === binding.shift
  );
}

function getActiveComposerHandle(): ComposerHandle | null {
  if (activeComposerId) {
    const active = composers.get(activeComposerId);
    if (active) return active;
  }
  const last = Array.from(composers.values()).at(-1);
  return last ?? null;
}

/** Live proxy — re-resolves the handle on every call, survives remounts */
function toLiveComposerTarget(composerId: string): ComposerTarget {
  return {
    getSnapshot: () => composers.get(composerId)?.getSnapshot() ?? { draft: "" },
    focus: () => composers.get(composerId)?.focus(),
    setDraft: (text: string) => composers.get(composerId)?.setDraft(text),
    insertText: (text: string) => composers.get(composerId)?.insertText(text),
    setGhostText: (text: string | null) => composers.get(composerId)?.setGhostText(text),
    submit: (text?: string) => composers.get(composerId)?.submit(text),
  };
}

async function performComposerAction(action: ComposerActionRegistration, composerId: string): Promise<void> {
  if (composers.has(composerId)) {
    activeComposerId = composerId;
  }
  await action.onClick({ composer: toLiveComposerTarget(composerId) });
}

async function performComposerToggle(toggle: ComposerToggleRegistration, composerId: string): Promise<void> {
  if (composers.has(composerId)) {
    activeComposerId = composerId;
  }
  const enabled = !(toggle.state.enabled ?? false);
  await toggle.onToggle({ composer: toLiveComposerTarget(composerId), enabled });
}

function ensureShortcutListener() {
  if (listenerAttached) return;
  window.addEventListener("keydown", (event) => {
    for (let i = shortcuts.length - 1; i >= 0; i--) {
      const shortcut = shortcuts[i];
      if (!shortcut) continue;
      if (!matchesShortcut(shortcut.binding, event)) continue;
      event.preventDefault();
      void shortcut.handler({ event, getComposer: getActiveComposerHandle });
      return;
    }
  });
  listenerAttached = true;
}

export function registerComposer(handle: ComposerHandle): () => void {
  composers.set(handle.id, handle);
  // Drain a queued draft first: it replaces the whole textarea, so an attach
  // chip staged alongside it must survive rather than be overwritten.
  const pendingDraft = pendingDrafts.get(handle.id);
  if (pendingDraft !== undefined) {
    pendingDrafts.delete(handle.id);
    try { handle.setDraft(pendingDraft); handle.focus(); }
    catch (err) { console.error("[composer] setDraft on register failed:", err); }
  }
  // Drain any pending attach queued before this composer mounted.
  const pending = pendingAttaches.get(handle.id);
  if (pending && handle.attachMove) {
    pendingAttaches.delete(handle.id);
    try { handle.attachMove(pending.move, pending.inputs); }
    catch (err) { console.error("[composer] attachMove on register failed:", err); }
  }
  notifyComposerControls();
  return () => {
    composers.delete(handle.id);
    pendingDrafts.delete(handle.id);
    if (activeComposerId === handle.id) {
      activeComposerId = Array.from(composers.keys()).at(-1) ?? null;
    }
    notifyComposerControls();
  };
}

export function activateComposer(id: string): void {
  if (composers.has(id)) activeComposerId = id;
}

/**
 * Attach a move to a composer by ID. If the composer is already mounted, delivers
 * immediately. Otherwise buffers the attach until `registerComposer(id)` is called
 * — this closes the race between `newSession()` and ChatInput mounting.
 */
export function queueComposerAttach(
  composerId: string,
  move: MoveListItem,
  inputs: Record<string, unknown>,
): void {
  const handle = composers.get(composerId);
  if (handle?.attachMove) {
    try { handle.attachMove(move, inputs); }
    catch (err) { console.error("[composer] attachMove failed:", err); }
    return;
  }
  pendingAttaches.set(composerId, { move, inputs });
}

/**
 * Seed a composer's draft by ID without sending it. Delivers immediately when
 * that composer is mounted, otherwise buffers until `registerComposer(id)`.
 *
 * This is the staging half of a cross-project launch: switching project,
 * creating or resuming a session, and landing an editable prompt all happen
 * before the target ChatInput exists, so the caller has no handle to write to.
 * Deliberately never submits — the text is a starting point the user edits.
 */
export function queueComposerDraft(composerId: string, text: string): void {
  const handle = composers.get(composerId);
  if (handle) {
    try { handle.setDraft(text); handle.focus(); }
    catch (err) { console.error("[composer] setDraft failed:", err); }
    return;
  }
  pendingDrafts.set(composerId, text);
}

export function useComposerActions(composerId: string): ComposerActionView[] {
  const snapshot = useSyncExternalStore(subscribeComposerControls, getComposerControlsSnapshot);
  return useMemo(() => Array.from(composerActions.values())
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map((action) => ({
      key: action.key,
      extensionId: action.extensionId,
      ...action.state,
      perform: () => performComposerAction(action, composerId),
    })), [snapshot, composerId]);
}

export function useComposerToggles(composerId: string): ComposerToggleView[] {
  const snapshot = useSyncExternalStore(subscribeComposerControls, getComposerControlsSnapshot);
  return useMemo(() => Array.from(composerToggles.values())
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map((toggle) => ({
      key: toggle.key,
      extensionId: toggle.extensionId,
      ...toggle.state,
      toggle: () => performComposerToggle(toggle, composerId),
    })), [snapshot, composerId]);
}

/**
 * Live option lists published by one loaded extension, keyed by setting name.
 * Empty when the extension is disabled or has not registered anything — the
 * settings UI then renders the manifest-declared field as before.
 */
export function useExtensionSettingOptions(
  extensionId: string,
): Record<string, SettingOptionsConfig> {
  const snapshot = useSyncExternalStore(subscribeComposerControls, getComposerControlsSnapshot);
  return useMemo(() => {
    const prefix = `${extensionId}:`;
    const result: Record<string, SettingOptionsConfig> = {};
    for (const [key, config] of settingOptions) {
      if (key.startsWith(prefix)) result[key.slice(prefix.length)] = config;
    }
    return result;
  }, [snapshot, extensionId]);
}

function createApi(extensionId: string, settings: Record<string, unknown> = {}): ClientExtensionApi {
  return {
    registerShortcut(binding, handler) {
      const registration: ShortcutRegistration = {
        id: extensionId,
        binding: parseShortcut(binding),
        handler,
      };
      shortcuts.push(registration);
      ensureShortcutListener();
      return () => {
        const idx = shortcuts.indexOf(registration);
        if (idx !== -1) shortcuts.splice(idx, 1);
      };
    },
    registerComposerAction(config) {
      const actionKey = `${extensionId}:${config.id ?? "default"}`;
      const registration: ComposerActionRegistration = {
        key: actionKey,
        extensionId,
        order: config.order ?? 0,
        onClick: config.onClick,
        state: {
          label: config.label,
          title: config.title,
          icon: config.icon,
          disabled: config.disabled,
          status: config.status,
        },
      };
      composerActions.set(actionKey, registration);
      notifyComposerControls();

      let removed = false;

      return {
        update(next) {
          if (removed) return;
          registration.state = { ...registration.state, ...next };
          notifyComposerControls();
        },
        unregister() {
          if (removed) return;
          removed = true;
          composerActions.delete(actionKey);
          notifyComposerControls();
        },
      };
    },
    registerSetting(name, config) {
      const settingKey = `${extensionId}:${name}`;
      settingOptions.set(settingKey, { ...config });
      notifyComposerControls();

      let removed = false;

      return {
        update(next) {
          if (removed) return;
          const current = settingOptions.get(settingKey);
          if (!current) return;
          settingOptions.set(settingKey, { ...current, ...next });
          notifyComposerControls();
        },
        unregister() {
          if (removed) return;
          removed = true;
          settingOptions.delete(settingKey);
          notifyComposerControls();
        },
      };
    },
    registerComposerToggle(config) {
      const toggleKey = `${extensionId}:${config.id ?? "default"}`;
      const registration: ComposerToggleRegistration = {
        key: toggleKey,
        extensionId,
        order: config.order ?? 0,
        onToggle: config.onToggle,
        state: {
          label: config.label,
          title: config.title,
          enabled: config.enabled,
          busy: config.busy,
          disabled: config.disabled,
          tone: config.tone,
        },
      };
      composerToggles.set(toggleKey, registration);
      notifyComposerControls();

      let removed = false;

      return {
        update(next) {
          if (removed) return;
          registration.state = { ...registration.state, ...next };
          notifyComposerControls();
        },
        unregister() {
          if (removed) return;
          removed = true;
          composerToggles.delete(toggleKey);
          notifyComposerControls();
        },
      };
    },
    getComposer() {
      return getActiveComposerHandle()?.getSnapshot() ?? null;
    },
    setDraft(text) {
      getActiveComposerHandle()?.setDraft(text);
    },
    insertText(text) {
      getActiveComposerHandle()?.insertText(text);
    },
    setGhostText(text) {
      getActiveComposerHandle()?.setGhostText(text);
    },
    focusComposer() {
      getActiveComposerHandle()?.focus();
    },
    submitComposer(text) {
      getActiveComposerHandle()?.submit(text);
    },
    request(path, init) {
      const url = path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `${API_BASE}${path}`;
      const headers = new Headers(init?.headers ?? {});
      const isFormDataBody = typeof FormData !== "undefined" && init?.body instanceof FormData;
      for (const [key, value] of Object.entries(authHeaders())) {
        if (isFormDataBody && key.toLowerCase() === "content-type") continue;
        if (!headers.has(key)) headers.set(key, value);
      }
      if (isFormDataBody) headers.delete("Content-Type");
      return fetch(url, { ...init, headers });
    },
    getSettings() {
      return { ...settings };
    },
  };
}

function toDefinition(mod: Record<string, unknown>): ClientExtensionDefinition | null {
  const candidate = mod.default ?? mod.extension ?? mod;
  if (typeof candidate === "function") return candidate as ClientExtensionDefinition;
  if (candidate && typeof candidate === "object") return candidate as ClientExtensionDefinition;
  return null;
}

export async function unloadClientExtensions(): Promise<void> {
  while (loadedExtensions.length > 0) {
    const extension = loadedExtensions.pop();
    try {
      extension?.cleanup?.();
    } catch {
      // ignore extension cleanup failures
    }
  }
  shortcuts.splice(0, shortcuts.length);
  composerActions.clear();
  composerToggles.clear();
  settingOptions.clear();
  loadedManifestKey = null;
  notifyComposerControls();
}

type ClientExtensionOnLoad = (api: ClientExtensionApi) => void | (() => void) | Promise<void | (() => void)>;

/** Test seam: fetch and evaluate one extension module, returning its onLoad. */
export type ClientExtensionModuleLoader = (
  item: ClientExtensionManifestItem,
) => Promise<ClientExtensionOnLoad | null>;

const evaluateExtensionModule: ClientExtensionModuleLoader = async (item) => {
  const moduleUrl = item.moduleUrl.startsWith("http://") || item.moduleUrl.startsWith("https://")
    ? item.moduleUrl
    : `${API_BASE}${item.moduleUrl}`;
  // Fetch through the authenticated client boundary, then evaluate from a
  // same-window blob. This keeps remote backend script origins out of the
  // Tauri CSP while still allowing trusted, backend-configured extensions.
  const response = await fetch(moduleUrl, { headers: authHeaders() });
  if (!response.ok) throw new Error(`Client extension fetch failed: ${response.status}`);
  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ blobUrl) as Record<string, unknown>;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const definition = toDefinition(mod);
  if (!definition) return null;
  return (typeof definition === "function" ? definition : definition.onLoad) ?? null;
};

export async function loadClientExtensions(
  items: ClientExtensionManifestItem[],
  opts?: { isCancelled?: () => boolean; moduleLoader?: ClientExtensionModuleLoader },
): Promise<void> {
  const manifestKey = extensionManifestKey(items);
  if (manifestKey === loadedManifestKey) return;
  // Evaluate the incoming set BEFORE unloading the current one. A refresh
  // fires on every step of a project or user-profile settle, and unloading
  // first left the composer without its extensions (mic, shortcuts) for the
  // whole fetch+import pipeline instead of one registration swap. A failed or
  // cancelled refresh must leave the current set untouched.
  const loader = opts?.moduleLoader ?? evaluateExtensionModule;
  const evaluated = await Promise.all(
    items.filter((item) => item.enabled).map(async (item) => ({
      item,
      onLoad: await loader(item),
    })),
  );
  if (opts?.isCancelled?.()) return;
  await unloadClientExtensions();
  for (const { item, onLoad } of evaluated) {
    if (opts?.isCancelled?.()) return;
    if (!onLoad) continue;
    const cleanup = await onLoad(createApi(item.id, item.settingsValues));
    loadedExtensions.push({
      id: item.id,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    });
  }
  loadedManifestKey = manifestKey;
}
