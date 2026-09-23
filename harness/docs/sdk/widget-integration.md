---
title: Widget Integration Guide
audience: dev
covers: harness/sdk/*.ts harness/move-runner.ts harness/ui/src/components/MoveWidget.tsx harness/ui/src/components/MoveWidgetEmbed.tsx
---

# Widget Integration Guide

Move widgets are React components served by the harness. This guide covers how to
load and mount them from both React and non-React contexts.

---

## 1. What widgets are

Move widgets are React components defined in a move's source directory and served
by the harness as transpiled JavaScript. When a move has a widget, the harness
exposes two endpoints:

- **`GET /api/moves/:name/widget?cwd=...`** — returns Bun-transpiled JS (ESM with
  bare `import` statements for `react`, `react/jsx-runtime`, etc.)
- **`GET /api/moves/:name/widget.css?cwd=...`** — returns the widget's CSS

Both endpoints require authentication. Prefer an `Authorization: Bearer` header.

A `?token=` parameter is accepted only because a browser constructs these URLs
itself (script/link elements cannot send a header), and only a **browser-session
token** is valid there. The supervisor `HARNESS_TOKEN` is rejected from a query
string on every route: a URL reaches history, copied links, and proxy logs, and
that credential authenticates every API and cannot be revoked without a restart.
A client holding the supervisor bearer trades it for a session token via
`POST /api/auth/exchange` (header-authenticated) and uses that in URLs.
When constructing URLs with `ModusClient`, pass that token as
`browserSessionToken` (or `getBrowserSessionToken` for a changing token). The
general `token` and `getToken` options authenticate API requests but never put
their bearer into a URL.

The JS output uses JSX runtime imports (`jsx`, `jsxs`, `jsxDEV`) rather than
`React.createElement` — this is important for the shimming approach below.

---

## 2. Mounting from the React app (easy path)

If you're inside the modus React app, use the `MoveWidget` component directly.
It handles module loading, import rewriting, and caching automatically.

Reference: `harness/ui/src/components/MoveWidget.tsx` (lines 110-157)

The React app's approach:
1. Fetches widget JS from the harness endpoint
2. Registers the host app's React on globals (`window.__MODUS_REACT__`, etc.)
3. Rewrites bare imports to reference those globals
4. Creates a blob URL from the rewritten source
5. Dynamic-imports the blob URL
6. Caches the resulting component for subsequent mounts

If you're already in a React context, this is the only path you need.

---

## 3. Mounting from non-React contexts (playground pattern)

For standalone HTML pages, Electron apps, or any non-React surface, you need to
bring React yourself and shim the imports. The playground (`playground/index.html`)
demonstrates this in ~50 lines.

### Step 1: Load React 18 UMD

```html
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
```

This gives you `window.React` and `window.ReactDOM`.

### Step 2: Fetch the widget source

```javascript
const res = await fetch(`${BASE}/api/moves/${moveName}/widget?cwd=${cwd}`, {
  headers: { Authorization: `Bearer ${token}` },
});
let js = await res.text();
```

### Step 3: Rewrite imports to global references

The widget source contains ESM imports like `import { useState } from "react"`.
Replace them with references to the UMD globals:

```javascript
// JSX dev runtime (development builds)
js = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']react\/jsx-dev-runtime["']/g,
  'const {$1} = window.__JSX_DEV__');

// JSX production runtime
js = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']react\/jsx-runtime["']/g,
  'const {$1} = window.__JSX__');

// React named imports
js = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']react["']/g,
  'const {$1} = React');

// React namespace imports
js = js.replace(/import\s*\*\s*as\s+(\w+)\s*from\s*["']react["']/g,
  'const $1 = React');

// React default imports
js = js.replace(/import\s+(\w+)\s*from\s*["']react["']/g,
  'const $1 = React');

// ReactDOM imports
js = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']react-dom["']/g,
  'const {$1} = ReactDOM');
```

### Step 4: Build a JSX runtime shim

Widgets use `jsx(type, props, key)` — not `React.createElement(type, props, ...children)`.
The key difference: JSX runtime puts `children` inside `props`, while `createElement`
expects children as rest arguments.

```javascript
function jsxShim(type, props, key) {
  if (props == null) return React.createElement(type, key !== undefined ? { key } : null);
  const { children, ...rest } = props;
  if (key !== undefined) rest.key = key;
  return Array.isArray(children)
    ? React.createElement(type, rest, ...children)
    : children !== undefined
      ? React.createElement(type, rest, children)
      : React.createElement(type, rest);
}

window.__JSX__ = { jsx: jsxShim, jsxs: jsxShim, Fragment: React.Fragment };
window.__JSX_DEV__ = { jsxDEV: jsxShim, Fragment: React.Fragment };
```

### Step 5: Dynamic-import via blob URL

```javascript
const blob = new Blob([js], { type: "application/javascript" });
const blobUrl = URL.createObjectURL(blob);
const mod = await import(blobUrl);
URL.revokeObjectURL(blobUrl);

const Comp = mod.default || mod.Widget || mod[moveName];
if (!Comp) throw new Error("no default export found in widget module");
```

### Step 6: Mount with ReactDOM

```javascript
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(Comp, {
  apiToken,
  instanceId,
  sessionId,
  moveName,
  callOp,
  submitMessage,
}));
```

For full isolation, mount the widget inside an iframe and write the entire HTML
document (including the React CDN scripts and shim code) into it. See the
playground's `buildWidgetIframeHtml()` for a complete example.

---

## 4. Widget props contract

Every widget component receives these props:

```typescript
interface WidgetProps {
  apiToken: string;       // Auth token for calling move operations
  instanceId: string;     // Unique move instance identifier
  sessionId: string;      // Associated session ID
  moveName: string;       // Name of the move
  callOp: (op: string, data?: any) => Promise<any>;  // Call move operations
  submitMessage: (text: string) => void;               // Send a message to the session
}
```

**`callOp(op, data)`** — calls the move's server-side operations via
`POST /api/moves/:name/op` with `{ apiToken, op, ...data }`.

**`submitMessage(text)`** — sends a user message to the session via
`POST /api/sessions/:id/messages`.

Both functions handle authentication internally — the widget doesn't need to
manage tokens for these calls.

---

## 5. Widget CSS

Widget styles are served at `/api/moves/:name/widget.css?cwd=...` (requires auth).

### Loading CSS

Fetch the CSS and inject it as a `<style>` tag:

```javascript
const cssRes = await fetch(cssUrl, {
  headers: { Authorization: `Bearer ${token}` },
});
if (cssRes.ok) {
  const css = await cssRes.text();
  if (css.trim()) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }
}
```

### Isolation

Widget CSS is not automatically scoped. If you're mounting widgets alongside
other content, use an iframe for full style isolation. The playground uses this
approach — each widget gets its own iframe with its own document, so widget
styles can't leak into the host page.

---

## Reference implementation

- **Non-React (playground):** `playground/index.html` — `buildWidgetIframeHtml()`
  function (lines ~411-527)
- **React app:** `harness/ui/src/components/MoveWidget.tsx` — `loadWidgetModule()`
  function (lines 110-157)
