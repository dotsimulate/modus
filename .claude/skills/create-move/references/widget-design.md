# Widget Design Reference

Widgets are not decorations — they are interactive surfaces. A widget that just displays
text in a list is a failure of imagination. The harness renders widgets inside a real
React app with a full design system, charting libraries, code editors, terminal emulators,
markdown renderers, and SVG/Canvas APIs. Use them.

## Design Expectations

**Every widget should be a tool someone wants to use**, not a status dump they glance at.
Before writing a widget, ask: what does the user *do* here? If the answer is "read text,"
you haven't designed a widget — you've designed a log viewer. Push further.

**Rich, reactive, interactive by default.** Widgets can and should:
- Render live-updating charts, graphs, and visualizations
- Use SVG or Canvas for custom drawings, force-directed layouts, node graphs
- Include interactive controls: buttons, sliders, toggles, drag-and-drop
- Show real-time data via polling or SSE subscription
- Use animations and transitions for state changes
- Embed code editors (CodeMirror is available), terminals (xterm.js), markdown (react-markdown + mermaid)
- Coordinate with other widgets via the page context state bus

**Anti-patterns to avoid:**
- Plain text lists with no visual hierarchy or interaction
- Status displays that are just key-value pairs with no affordances
- Walls of unstyled text — if you're rendering text, use the Markdown component
- Generic "card" layouts with no domain-specific design thinking
- Widgets that could be replaced by a `console.log` — if it doesn't benefit from being visual, it shouldn't be a widget

## What's Available

### React & Libraries (all pre-bundled in harness/ui)

| Library | Use for |
|---------|---------|
| `react` 19 | Components, hooks, state |
| `lucide-react` | Icon library — hundreds of icons, use freely |
| `react-markdown` + `remark-gfm` + `rehype-raw` | Rich markdown with GFM tables, raw HTML |
| `highlight.js` | Syntax highlighting for 18+ languages |
| `mermaid` | Flowcharts, sequence diagrams, class diagrams, etc. |
| `@codemirror/*` | Full code editor (JS, JSON, Python, Markdown, CSS, HTML) |
| `@xterm/xterm` | Terminal emulation with WebGL rendering |

Plus standard browser APIs: Canvas, SVG, Web Audio, CSS animations, `requestAnimationFrame`.

### Importable Components

From `harness/ui/src/widgets/widget-components.tsx`:

| Component | What it does |
|-----------|-------------|
| `ActivityChart` | 30-day bar chart (sessions or cost over time) |
| `HBar` | Tiny horizontal progress bar |
| `CustomSelect` | Styled dropdown select |
| `Markdown` | Full markdown renderer with syntax highlighting + mermaid diagrams |
| `WidgetEmptyState` | Loading/empty/unavailable container |

Import path from a move widget:
```tsx
import { Markdown, HBar, WidgetEmptyState } from "../../../../harness/ui/src/widgets/widget-components";
```

### Importable Hooks

From `harness/ui/src/widgets/widget-data.ts`:
```tsx
import { useWidgetPollingValue } from "../../../../harness/ui/src/widgets/widget-data";

const { value, loading, refresh } = useWidgetPollingValue({
  load: () => callOp("read-status", {}),
  scopeKey: "training-status",
  intervalMs: 10_000,
  initialValue: null,
});
```

From `harness/ui/src/widgets/ui-state.ts`:
```tsx
import { useWidgetUiState } from "../../../../harness/ui/src/widgets/ui-state";

// Persists to localStorage, survives remounts
const [viewMode, setViewMode] = useWidgetUiState(scope, widgetId, "viewMode", "grid");
```

From `harness/ui/src/widgets/chrome.ts`:
```tsx
import { useWidgetChrome } from "../../../../harness/ui/src/widgets/chrome";

const { setHeaderSuffix } = useWidgetChrome();
setHeaderSuffix("3 running"); // shows in the widget tab header
```

### Page Context (for page-embedded widgets)

When a widget is rendered inside a page layout, it receives `pageContext` in its props:

```tsx
export default function MyWidget({ callOp, pageContext }: MoveWidgetProps) {
  // Read/write shared page state
  const selectedId = pageContext?.get("selectedId");
  pageContext?.set("selectedId", "abc123");

  // Subscribe to events from other widgets
  useEffect(() => {
    if (!pageContext) return;
    return pageContext.on("select-session", (intent) => {
      // react to session selection from another widget
    });
  }, [pageContext]);

  // Emit intents for other widgets to handle
  const openFile = () => pageContext?.emit({
    type: "open-file", path: "/src/index.ts", line: 42
  });
}
```

## The Modus Design Baseline

The harness ships a dark-first design system with CSS custom properties. This is the
default visual language — clean, dense, monospace-forward. Using it gives your widget
a native feel with zero effort. You are not required to use it — widgets can define
any visual style — but it is the quality floor. If you diverge, exceed it.

### CSS Token Catalog

Use `var(--token)` in your `widget.css`. These adapt to light/dark theme automatically.

**Backgrounds:**
`--bg` (main), `--bg-raised` (elevated surface), `--bg-surface` (card/section),
`--bg-hover` (hover state), `--thinking` (processing blocks)

**Borders:**
`--border` (default), `--border-active` (focus), `--border-mid` (mid-tone),
`--border-visible` (strong), `--border-focus` (input focus)

**Text:**
`--text` (primary), `--text-secondary` (secondary), `--text-label` (labels),
`--text-tertiary` (tertiary), `--text-dim` (dimmed), `--text-muted` (muted),
`--text-placeholder` (placeholder), `--accent` (accent — white in dark, black in light)

**Status:**
`--success`, `--warning`, `--error`, `--error-soft`, `--error-dim`, `--info`

**Status dots (for indicators/badges):**
`--dot-running`, `--dot-idle`, `--dot-done`, `--dot-error`, `--dot-connected`

**Syntax highlighting:**
`--syn-keyword`, `--syn-builtin`, `--syn-type`, `--syn-literal`, `--syn-number`,
`--syn-string`, `--syn-regexp`, `--syn-comment`, `--syn-function`, `--syn-variable`,
`--syn-tag`, `--syn-attr`, `--syn-addition`, `--syn-deletion`

**Fonts:**
`--font-mono` (JetBrains Mono), `--font-sans` (IBM Plex Sans), `--font-scale` (multiplier)

### CSS Rules

```css
/* ALWAYS scale fonts — never raw px */
font-size: calc(11px * var(--font-scale, 1));

/* ALWAYS use token colors — never hardcoded hex */
color: var(--text-secondary);
background: var(--bg-surface);
border: 1px solid var(--border);

/* Monospace for data-heavy content */
font-family: var(--font-mono);

/* Native form controls */
accent-color: var(--text-secondary);
```

### Widget Anatomy (Compact Panel Pattern)

The standard widget layout for panel-mounted widgets:

```css
.my-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: var(--font-mono);
  background: var(--bg);
  overflow: hidden;
}

.my-header {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.my-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}

.my-footer {
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  font-size: calc(9px * var(--font-scale, 1));
  color: var(--text-dim);
}
```

### Common UI Patterns

**Status badges:**
```css
.my-badge {
  font-size: calc(9px * var(--font-scale, 1));
  padding: 1px 6px;
  border-radius: 2px;
  letter-spacing: 0.04em;
}
.my-badge-ok { color: var(--success); background: rgba(var(--success), 0.1); }
```

**Ghost buttons:**
```css
.my-btn {
  background: transparent;
  border: none;
  font-family: var(--font-mono);
  font-size: calc(10px * var(--font-scale, 1));
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px 6px;
  transition: color 0.1s ease;
}
.my-btn:hover { color: var(--text-secondary); }
```

**Key-value rows:**
```css
.my-row {
  display: flex;
  justify-content: space-between;
  padding: 2px 0;
  font-size: calc(10px * var(--font-scale, 1));
}
.my-row-label { color: var(--text-dim); }
.my-row-value { color: var(--text); }
```

**Section headers:**
```css
.my-section-title {
  font-size: calc(9px * var(--font-scale, 1));
  color: var(--text-dim);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: 8px 0 4px;
}
```

### CSS Class Namespacing

Prefix ALL classes with a short move-specific prefix to avoid collisions:
`council-`, `chess-`, `ts-`, `mem-`, etc. Never use generic class names like
`.header`, `.row`, `.status`.

## Going Beyond the Baseline

The baseline is a floor, not a ceiling. Widgets that need custom visuals should build them:

**SVG visualizations** — Force-directed graphs, node trees, data plots. Use
`requestAnimationFrame` for animation loops. The memory widget renders an entire
force-directed node graph with SVG.

**Canvas rendering** — For heavy drawing, pixel-level control, or game-like UIs.

**CSS animations and keyframes** — Inject via a `<style>` tag or widget.css. Animate
state transitions, loading indicators, data updates.

**Custom color palettes** — If your widget has domain-specific color needs (e.g., a
heatmap, a game board, syntax themes), define them as CSS custom properties in your
widget.css and document them. Just ensure the *chrome* (borders, backgrounds, text
outside the custom area) still uses the harness tokens so the widget fits its container.

**Third-party libraries** — If it's in `harness/ui/package.json`, you can import it.
CodeMirror for editors, xterm for terminals, mermaid for diagrams. These are real
tools — use them to build real interfaces.

## Design Checklist

Before shipping a widget, verify:

- [ ] **Interactive** — the user can *do* something, not just *read* something
- [ ] **Reactive** — data updates are visible without manual refresh (polling or SSE)
- [ ] **Scaled fonts** — every `font-size` uses `calc(Npx * var(--font-scale, 1))`
- [ ] **Token colors** — no hardcoded hex values; all colors via `var(--*)`
- [ ] **Namespaced classes** — all CSS classes prefixed with move-specific prefix
- [ ] **Overflow handled** — scrollable body, fixed header/footer, no layout blowout
- [ ] **Empty states** — graceful handling of no-data, loading, and error conditions
- [ ] **Dense but readable** — compact padding (6-12px), clear visual hierarchy
