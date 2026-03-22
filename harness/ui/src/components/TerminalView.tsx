/**
 * TerminalView — xterm.js-backed terminal panel for the right sidebar.
 *
 * Backend PTY processes are the source of truth. On mount, this component
 * fetches existing terminals from the API and reconnects to them. New
 * terminals are created via the API. Page reloads reconnect seamlessly —
 * scrollback is replayed from the backend buffer.
 *
 * This component is mounted persistently (hidden when not active) so
 * terminals survive tab switches within the right panel.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import {
  createTerminal as apiCreateTerminal,
  listTerminals as apiListTerminals,
  connectTerminalWS,
  deleteTerminal as apiDeleteTerminal,
  type TerminalInfo,
} from "../api/terminals";

// ── Types ──

type TerminalInstance = {
  info: TerminalInfo;
  xterm: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  ws: WebSocket | null;
  dead: boolean;
  /** The wrapper div that xterm renders into — created once, moved between mounts */
  el: HTMLDivElement;
  opened: boolean;
  /** Ping interval ID for keepalive */
  pingInterval: ReturnType<typeof setInterval> | null;
  /** Reconnect timeout ID */
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  /** Whether this instance has been disposed */
  disposed: boolean;
};

type Props = {
  cwd?: string | null;
  visible?: boolean;
  sessionId?: string | null;
};

// ── Constants ──

const XTERM_OPTIONS = {
  cursorBlink: true,
  cursorStyle: "bar" as const,
  fontSize: 12,
  fontFamily: "'JetBrains Mono', monospace",
  scrollback: 10000,
  allowProposedApi: true,
};

const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 2000;
const RESIZE_DEBOUNCE_MS = 100;

// ── Read computed CSS vars from :root for xterm theme ──

function resolveThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--bg", "#000000"),
    foreground: v("--text", "#e0e0e0"),
    cursor: v("--text-secondary", "#bbbbbb"),
    selectionBackground: "rgba(255, 255, 255, 0.12)",
    black: v("--bg", "#000000"),
    red: v("--error", "#ff3333"),
    green: v("--success", "#33cc33"),
    yellow: v("--warning", "#e89b50"),
    blue: v("--info", "#5090ff"),
    magenta: v("--syn-keyword", "#c678dd"),
    cyan: v("--syn-symbol", "#56b6c2"),
    white: v("--text", "#e0e0e0"),
    brightBlack: v("--text-muted", "#444444"),
    brightRed: "#ff5555",
    brightGreen: "#55ff55",
    brightYellow: "#ffcc55",
    brightBlue: "#7799ff",
    brightMagenta: "#dd99ff",
    brightCyan: "#77ddee",
    brightWhite: v("--accent", "#ffffff"),
  };
}

// ── Send resize to backend ──

function sendResize(instance: TerminalInstance) {
  try {
    instance.fit.fit();
    const dims = instance.fit.proposeDimensions();
    if (dims && instance.ws?.readyState === WebSocket.OPEN) {
      instance.ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
    }
  } catch { /* detached */ }
}

// ── WebSocket connection + reconnect ──

function connectWS(
  instance: TerminalInstance,
  setInstances: React.Dispatch<React.SetStateAction<TerminalInstance[]>>,
) {
  if (instance.disposed) return;

  const ws = connectTerminalWS(instance.info.id);
  instance.ws = ws;

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      instance.xterm.write(new Uint8Array(e.data));
    } else if (typeof e.data === "string") {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "exit") {
          instance.dead = true;
          setInstances((prev) => [...prev]);
        }
        // pong messages are silently consumed
      } catch {
        instance.xterm.write(e.data);
      }
    }
  };

  ws.onclose = () => {
    // Clear keepalive
    if (instance.pingInterval) {
      clearInterval(instance.pingInterval);
      instance.pingInterval = null;
    }
    // If the terminal process exited or instance disposed, don't reconnect
    if (instance.dead || instance.disposed) return;
    // Attempt reconnection
    instance.reconnectTimeout = setTimeout(() => {
      connectWS(instance, setInstances);
    }, RECONNECT_DELAY_MS);
  };

  ws.onopen = () => {
    // Start keepalive ping
    instance.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
    // Sync size on reconnect
    sendResize(instance);
  };
}

// ── Shared xterm+WS wiring ──

function wireInstance(
  info: TerminalInfo,
  setInstances: React.Dispatch<React.SetStateAction<TerminalInstance[]>>,
): TerminalInstance {
  const xterm = new Terminal({
    ...XTERM_OPTIONS,
    theme: resolveThemeColors(),
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  const unicode11 = new Unicode11Addon();

  xterm.loadAddon(fit);
  xterm.loadAddon(new WebLinksAddon());
  xterm.loadAddon(search);
  xterm.loadAddon(unicode11);
  xterm.loadAddon(new ClipboardAddon());

  xterm.unicode.activeVersion = "11";

  // Persistent wrapper element — created once, xterm opens into it once
  const el = document.createElement("div");
  el.className = "term-instance";

  const instance: TerminalInstance = {
    info, xterm, fit, search, ws: null, dead: false, el, opened: false,
    pingInterval: null, reconnectTimeout: null, disposed: false,
  };

  // Wire input to WS
  xterm.onData((data) => {
    if (instance.ws?.readyState === WebSocket.OPEN) {
      instance.ws.send(new TextEncoder().encode(data));
    }
  });

  xterm.onBinary((data) => {
    if (instance.ws?.readyState === WebSocket.OPEN) {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
      instance.ws.send(bytes);
    }
  });

  // Right-click: copy if selection, paste if no selection
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (xterm.hasSelection()) {
      navigator.clipboard.writeText(xterm.getSelection());
      xterm.clearSelection();
    } else {
      navigator.clipboard.readText().then((text) => {
        if (text && instance.ws?.readyState === WebSocket.OPEN) {
          instance.ws.send(new TextEncoder().encode(text));
        }
      }).catch(() => {});
    }
  });

  // Ctrl+C copies when there's a selection, sends SIGINT otherwise
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.ctrlKey && e.key === "c" && xterm.hasSelection()) {
      navigator.clipboard.writeText(xterm.getSelection());
      xterm.clearSelection();
      return false; // prevent sending \x03
    }
    return true;
  });

  // Connect WebSocket
  connectWS(instance, setInstances);

  return instance;
}

// ── Dispose an instance cleanly ──

function disposeInstance(inst: TerminalInstance) {
  inst.disposed = true;
  if (inst.pingInterval) clearInterval(inst.pingInterval);
  if (inst.reconnectTimeout) clearTimeout(inst.reconnectTimeout);
  inst.ws?.close();
  inst.xterm.dispose();
  inst.el.remove();
}

// ── Component ──

export function TerminalView({ cwd, visible, sessionId }: Props) {
  const [instances, setInstances] = useState<TerminalInstance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const instancesRef = useRef(instances);
  instancesRef.current = instances;

  const active = instances.find((t) => t.info.id === activeId) ?? null;

  // ── Reconnect to existing backend terminals on mount or session change ──

  useEffect(() => {
    // Dispose previous instances when session changes
    for (const inst of instancesRef.current) {
      disposeInstance(inst);
    }
    setInstances([]);
    setActiveId(null);
    setLoaded(false);

    if (!sessionId) { setLoaded(true); return; }

    let cancelled = false;
    (async () => {
      try {
        const existing = await apiListTerminals(sessionId);
        if (cancelled) return;
        if (existing.length > 0) {
          const reconnected: TerminalInstance[] = [];
          for (const info of existing) {
            reconnected.push(wireInstance(info, setInstances));
          }
          setInstances(reconnected);
          instancesRef.current = reconnected;
          setActiveId(existing[existing.length - 1].id);
        }
      } catch { /* startup race */ }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Create a new terminal ──

  const handleCreate = useCallback(async () => {
    // Measure real dimensions before creating the PTY so the shell
    // starts at the correct size (avoids the 80x24 -> fit resize race).
    const container = containerRef.current;
    let cols = 80, rows = 24;
    if (container) {
      const probe = new Terminal({ ...XTERM_OPTIONS });
      const probeFit = new FitAddon();
      probe.loadAddon(probeFit);
      const probeEl = document.createElement("div");
      probeEl.className = "term-instance";
      probeEl.style.visibility = "hidden";
      probeEl.style.position = "absolute";
      container.appendChild(probeEl);
      probe.open(probeEl);
      probeFit.fit();
      const dims = probeFit.proposeDimensions();
      if (dims) { cols = dims.cols; rows = dims.rows; }
      probe.dispose();
      probeEl.remove();
    }

    const info = await apiCreateTerminal({ cwd: cwd ?? undefined, cols, rows, sessionId: sessionId ?? undefined });
    const instance = wireInstance(info, setInstances);
    setInstances((prev) => [...prev, instance]);
    setActiveId(info.id);
  }, [cwd, sessionId]);

  // ── Close a terminal ──

  const handleClose = useCallback((id: string) => {
    const inst = instancesRef.current.find((t) => t.info.id === id);
    if (inst) {
      disposeInstance(inst);
      apiDeleteTerminal(id).catch(() => {});
    }
    setInstances((prev) => {
      const next = prev.filter((t) => t.info.id !== id);
      setActiveId((curr) => {
        if (curr === id) return next.length > 0 ? next[next.length - 1].info.id : null;
        return curr;
      });
      return next;
    });
  }, []);

  // ── Attach active terminal's element to the container ──

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;

    // Move the persistent element into the viewport container
    container.innerHTML = "";
    container.appendChild(active.el);

    // First time: open xterm now that the element is in the DOM with real dimensions
    if (!active.opened) {
      active.xterm.open(active.el);
      active.opened = true;

      // Refresh theme now that element is in DOM and CSS vars are resolved
      active.xterm.options.theme = resolveThemeColors();

      // Load WebGL renderer after open() — with fallback
      try {
        active.xterm.loadAddon(new WebglAddon());
      } catch {
        // WebGL2 not available — falls back to canvas renderer
      }
    }

    // Fit and sync size with backend
    sendResize(active);
    active.xterm.focus();
  }, [active]);

  // ── Refit when becoming visible ──

  useEffect(() => {
    if (!visible || !active) return;
    const t = setTimeout(() => {
      sendResize(active);
      active.xterm.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [visible, active]);

  // ── Resize on container size change (debounced) ──

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => sendResize(active), RESIZE_DEBOUNCE_MS);
    });

    ro.observe(container);
    return () => {
      ro.disconnect();
      if (timeout) clearTimeout(timeout);
    };
  }, [active]);

  // ── Cleanup on unmount ──

  useEffect(() => {
    return () => {
      for (const inst of instancesRef.current) {
        disposeInstance(inst);
      }
    };
  }, []);

  // ── Render ──

  if (!loaded) return null;

  if (instances.length === 0) {
    return (
      <div className="term-panel">
        <div className="term-empty">
          <button className="term-create-btn" onClick={handleCreate}>
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            New terminal
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="term-panel">
      <div className="term-tabs">
        {instances.map((inst, i) => (
          <div
            key={inst.info.id}
            className={`term-tab${inst.info.id === activeId ? " term-tab--active" : ""}${inst.dead ? " term-tab--dead" : ""}`}
          >
            <button
              className="term-tab-label"
              onClick={() => setActiveId(inst.info.id)}
              title={inst.info.cwd ?? inst.info.shell}
            >
              {inst.dead ? "\u00d7 " : ""}term {i + 1}
            </button>
            <button
              className="term-tab-close"
              onClick={(e) => { e.stopPropagation(); handleClose(inst.info.id); }}
              title="Close terminal"
            >
              <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
                <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
        <button className="term-tab-add" onClick={handleCreate} title="New terminal">
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="term-viewport" ref={containerRef} />
    </div>
  );
}
