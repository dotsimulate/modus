import { useSyncExternalStore } from "react";
import { API_BASE, authHeaders } from "./modusClient";
import type { ClientExtensionManifestItem } from "../../sdk/index";

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
  submit: (text?: string) => void;
};

type ComposerTarget = Omit<ComposerHandle, "id">;

type ShortcutHandler = (ctx: {
  event: KeyboardEvent;
  getComposer: () => ComposerTarget | null;
}) => void | Promise<void>;

type ComposerActionIcon = "mic" | "mic-handsfree";

type ComposerActionStatusTone = "default" | "active" | "busy" | "error";

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

type ClientExtensionApi = {
  registerShortcut: (binding: string, handler: ShortcutHandler) => () => void;
  registerComposerAction: (config: ComposerActionConfig) => RegisteredComposerAction;
  getComposer: () => ComposerSnapshot | null;
  setDraft: (text: string) => void;
  insertText: (text: string) => void;
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

type ShortcutBinding = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

const composers = new Map<string, ComposerHandle>();
let activeComposerId: string | null = null;
const shortcuts: ShortcutRegistration[] = [];
const composerActions = new Map<string, ComposerActionRegistration>();
const loadedExtensions: LoadedExtension[] = [];
let listenerAttached = false;
const composerActionListeners = new Set<() => void>();
let composerActionSnapshot = 0;

function notifyComposerActions() {
  composerActionSnapshot++;
  for (const listener of composerActionListeners) listener();
}

function subscribeComposerActions(listener: () => void): () => void {
  composerActionListeners.add(listener);
  return () => composerActionListeners.delete(listener);
}

function getComposerActionsSnapshot(): number {
  return composerActionSnapshot;
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
    submit: (text?: string) => composers.get(composerId)?.submit(text),
  };
}

async function performComposerAction(action: ComposerActionRegistration, composerId: string): Promise<void> {
  if (composers.has(composerId)) {
    activeComposerId = composerId;
  }
  await action.onClick({ composer: toLiveComposerTarget(composerId) });
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
  notifyComposerActions();
  return () => {
    composers.delete(handle.id);
    if (activeComposerId === handle.id) {
      activeComposerId = Array.from(composers.keys()).at(-1) ?? null;
    }
    notifyComposerActions();
  };
}

export function activateComposer(id: string): void {
  if (composers.has(id)) activeComposerId = id;
}

export function useComposerActions(composerId: string): ComposerActionView[] {
  useSyncExternalStore(subscribeComposerActions, getComposerActionsSnapshot);
  return Array.from(composerActions.values())
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map((action) => ({
      key: action.key,
      extensionId: action.extensionId,
      ...action.state,
      perform: () => performComposerAction(action, composerId),
    }));
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
      notifyComposerActions();

      let removed = false;

      return {
        update(next) {
          if (removed) return;
          registration.state = { ...registration.state, ...next };
          notifyComposerActions();
        },
        unregister() {
          if (removed) return;
          removed = true;
          composerActions.delete(actionKey);
          notifyComposerActions();
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
  notifyComposerActions();
}

export async function loadClientExtensions(items: ClientExtensionManifestItem[]): Promise<void> {
  await unloadClientExtensions();
  for (const item of items) {
    if (!item.enabled) continue;
    const moduleUrl = item.moduleUrl.startsWith("http://") || item.moduleUrl.startsWith("https://")
      ? item.moduleUrl
      : `${API_BASE}${item.moduleUrl}`;
    const mod = await import(/* @vite-ignore */ moduleUrl);
    const definition = toDefinition(mod as Record<string, unknown>);
    if (!definition) continue;
    const onLoad = typeof definition === "function" ? definition : definition.onLoad;
    if (!onLoad) continue;
    const cleanup = await onLoad(createApi(item.id, item.settingsValues));
    loadedExtensions.push({
      id: item.id,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    });
  }
}
