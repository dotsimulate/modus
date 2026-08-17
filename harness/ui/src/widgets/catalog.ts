/**
 * Widget catalog — everything about the built-in widgets except their React
 * components.
 *
 * This file exists so widget metadata can be read without importing fifty
 * component trees. `registry.ts` binds a component onto each entry here; the
 * page linter and the docs generator import this module alone, which is what
 * lets both of them run in `bun test` with no React, no DOM, and no CodeMirror
 * or xterm executing at module scope.
 *
 * `description` is optional on purpose. An entry with no description means
 * nobody has written one, and the generated catalog says so — an invented
 * description is worse than an admitted gap, because a page author cannot tell
 * the two apart.
 *
 * To add a widget: add an entry here, then import the component in
 * `registry.ts` and bind it. `widgetCatalog.test.ts` fails if the two drift.
 */

import type { WidgetMeta } from "./types";

export const WIDGET_META: Record<string, WidgetMeta> = {
  "about": {
    type: "about",
    description:
      "Build identity and help. Renders the shared AboutPanel; all content comes from GET /api/about.",
    zones: ["dashboard", "left-panel", "right-panel"],
    minHeight: 200,
    preferredHeight: 460,
  },
  "action-card": {
    type: "action-card",
    description:
      "One action's status, last-run info, and a trigger button.",
    config: [
      { name: "actionName", type: "string", description: "Which action to show." },
    ],
    minHeight: 80,
    preferredHeight: 150,
    maxHeight: 200,
  },
  "account": {
    type: "account",
    description: "Claude Code account info and a time-period cost breakdown.",
    minHeight: 100,
    preferredHeight: 220,
    maxHeight: 280,
  },
  "actions-manager": {
    type: "actions-manager",
    description:
      "The full actions view as a page-embeddable widget. Resolves cwd and profile from ProfileContext.",
    minHeight: 200,
    preferredHeight: 500,
    handles: ["open-terminal"],
  },
  "agent-activity": {
    type: "agent-activity",
    description:
      "Live feed of every tool call in the session, newest first, as per-tool cards: Read shows file, dir, line range and line count plus an open-file button; Edit/Write show +adds/-dels; Grep shows hit count; Bash shows the description; TodoWrite draws a progress bar; sub-agents show their call count. Each card expands to detail and clicking one scrolls the transcript to that call. This is the built-in tool-activity surface — prefer it over rendering tool calls yourself.",
    zones: ["left-panel", "right-panel"],
    minHeight: 100,
    preferredHeight: 250,
  },
  "claude-pricing": {
    type: "claude-pricing",
    description:
      "Identity, period costs, KPI numbers, and activity charts in one tabbed widget.",
    minHeight: 100,
    preferredHeight: 220,
  },
  "code-editor": {
    type: "code-editor",
    zones: ["left-panel", "right-panel"],
    minHeight: 200,
    preferredHeight: 400,
    handles: [
      { type: "open-file", hooks: ["open", "focus", "expand"] },
      { type: "focus-widget", hooks: ["focus"] },
    ],
  },
  "composer": {
    type: "composer",
    description:
      "The full compose area: session ConfigBar above ChatInput. Subscribes to `sessionId` from page context.",
    config: [
      { name: "sessionId", type: "string", description: "Pin to a session instead of reading page context." },
      { name: "persistOpen", type: "boolean", description: "Keep the composer expanded." },
    ],
    minHeight: 60,
    preferredHeight: 120,
    maxHeight: 200,
  },
  "config-bar": {
    type: "config-bar",
    description:
      "The session config/profile strip alone. Allows profile switching and model/effort changes.",
    config: [
      { name: "sessionId", type: "string", description: "Pin to a session instead of reading page context." },
    ],
    minHeight: 30,
    preferredHeight: 40,
    maxHeight: 300,
  },
  "config-inspector": {
    type: "config-inspector",
    description:
      "The resolved configuration cascade for the active session, each value tagged with its origin (profile / user / session / default).",
    minHeight: 60,
    preferredHeight: 160,
    maxHeight: 240,
  },
  "deep-analytics": {
    type: "deep-analytics",
    minHeight: 140,
    preferredHeight: 280,
  },
  "default-agent": {
    type: "default-agent",
    description: "What configuration new sessions will use.",
    minHeight: 60,
    preferredHeight: 160,
    maxHeight: 220,
  },
  "docs": {
    type: "docs",
    description:
      "In-app reader for the built-in documentation set: search box, audience filter, and doc list beside the selected doc rendered as markdown.",
    zones: ["dashboard", "left-panel", "right-panel"],
    minHeight: 240,
    preferredHeight: 560,
  },
  "extensions": {
    type: "extensions",
    description: "Manage client extensions — enable/disable and per-extension settings.",
    minHeight: 100,
    preferredHeight: 220,
  },
  "inbox": {
    type: "inbox",
    description:
      "Sessions awaiting a user response — where the agent has replied and is waiting. Each card shows profile, a preview of the last response, and time since.",
    minHeight: 150,
    preferredHeight: 400,
  },
  "mission-graph": {
    type: "mission-graph",
    description:
      "DAG view of a mission run: spawned sessions as nodes with typed, directional transfer edges.",
    minHeight: 300,
    preferredHeight: 600,
  },
  "missions": {
    type: "missions",
    description:
      "Mission definitions as a list; each row expands inline to the active or last run's steps, gates, transfers, and spawned sessions.",
    minHeight: 200,
    preferredHeight: 500,
  },
  "moves": {
    type: "moves",
    description:
      "Compact list of available moves. A row expands inline to description, inputs, and an attach button.",
    minHeight: 100,
    preferredHeight: 220,
    handles: ["open-move", "close-move"],
  },
  "new-session": {
    type: "new-session",
    description:
      "Centred profile picker plus new-chat button, for the empty state of a chat page. Clicking a profile creates a session.",
    minHeight: 200,
    preferredHeight: 400,
  },
  "notes": {
    type: "notes",
    zones: ["left-panel", "right-panel", "dashboard"],
    minHeight: 220,
    preferredHeight: 560,
  },
  "pages-browser": {
    type: "pages-browser",
    description:
      "Manages the active user's page nav set — enable, pin, and order, sharing PagePicker with the top-nav launcher.",
    zones: ["dashboard", "left-panel", "right-panel"],
    minHeight: 160,
    preferredHeight: 400,
  },
  "persistent-terminal": {
    type: "persistent-terminal",
    zones: ["left-panel", "right-panel", "dashboard"],
    minHeight: 150,
    preferredHeight: 300,
  },
  "processes": {
    type: "processes",
    minHeight: 100,
    preferredHeight: 220,
  },
  "profile-card": {
    type: "profile-card",
    description: "Compact view of the selected agent profile's config.",
    config: [
      { name: "profileName", type: "string", description: "Pin to a named profile instead of the selected one." },
    ],
    minHeight: 80,
    preferredHeight: 180,
    maxHeight: 240,
  },
  "profiles-manager": {
    type: "profiles-manager",
    description:
      "The full agent-profiles view as a page-embeddable widget. Resolves everything from ProfileContext and SessionContext.",
    minHeight: 200,
    preferredHeight: 500,
  },
  "project-theme": {
    type: "project-theme",
    minHeight: 120,
    preferredHeight: 220,
  },
  "provider-status": {
    type: "provider-status",
    description: "Health overview of all registered providers.",
    minHeight: 80,
    preferredHeight: 180,
    maxHeight: 240,
  },
  "provider-usage": {
    type: "provider-usage",
    minHeight: 100,
    preferredHeight: 220,
  },
  "hints-launcher": {
    type: "hints-launcher",
    description:
      "Intent-routing gate: takes a draft intent, runs the built-in `hints` move in the background, and renders session / move / profile recommendation cards with keyboard nav.",
    zones: ["dashboard", "left-panel", "right-panel"],
    minHeight: 180,
    preferredHeight: 360,
  },
  "session-chat": {
    type: "session-chat",
    description:
      "The conversation transcript for one session — the main chat surface, with live SSE streaming. Its interior is opaque: a page can position it but cannot recompose what a message looks like.",
    config: [
      { name: "sessionId", type: "string", description: "Pin to a session instead of reading page context." },
    ],
    minHeight: 200,
    preferredHeight: 500,
  },
  "session-control": {
    type: "session-control",
    description:
      "Provider, model, and effort controls for the active session — the key ConfigBar controls in a panel-shaped widget.",
    minHeight: 80,
    preferredHeight: 150,
    maxHeight: 220,
  },
  "session-edits": {
    type: "session-edits",
    zones: ["left-panel", "right-panel"],
    minHeight: 100,
    preferredHeight: 250,
  },
  "session-history": {
    type: "session-history",
    minHeight: 200,
    preferredHeight: 400,
  },
  "session-info": {
    type: "session-info",
    description: "Metadata for the active chat session.",
    minHeight: 60,
    preferredHeight: 180,
    maxHeight: 260,
  },
  "session-list": {
    type: "session-list",
    description:
      "The sidebar session list as a panel widget, sourced from SessionProvider and ProfileProvider. Can live in any panel on any view.",
    config: [
      { name: "groupMode", type: '"time" | "agent"', description: "How rows are grouped." },
      { name: "focusTabOnSelect", type: "string", description: "Tab id to focus after a row is chosen." },
    ],
    minHeight: 160,
    preferredHeight: 320,
    handles: [
      { type: "select-session", hooks: ["activate"] },
    ],
  },
  "session-sidebar": {
    type: "session-sidebar",
    description:
      "Session metadata and stats: status, profile, model, token usage, cost, duration.",
    config: [
      { name: "sessionId", type: "string", description: "Pin to a session instead of reading page context." },
    ],
    minHeight: 150,
    preferredHeight: 300,
  },
  "artifact-shelf": {
    type: "artifact-shelf",
    zones: ["dashboard", "left-panel", "right-panel"],
    minHeight: 260,
    preferredHeight: 620,
  },
  "session-streams": {
    type: "session-streams",
    zones: ["left-panel", "right-panel", "dashboard"],
    minHeight: 220,
    preferredHeight: 420,
  },
  "session-turn": {
    type: "session-turn",
    description:
      "One turn of a conversation as a configurable projection — which parts of the turn to draw, with position left entirely to the page layout. Reads `turnSeq` from page context; with no ticker on the page it tracks the newest turn. Segments always render in provider order; filtering omits, never reorders.",
    config: [
      { name: "blocks", type: '("prompt"|"thinking"|"text"|"tools"|"meta")[]', description: "Which parts to draw. Default: all." },
      { name: "promptMaxHeight", type: "number", description: "Height at which the prompt scrolls instead of growing." },
      { name: "header", type: "boolean", description: "Show the turn number and timestamp. Default true." },
      { name: "sessionId", type: "string", description: "Pin to a session instead of reading page context." },
    ],
    zones: ["left-panel", "right-panel", "dashboard"],
    minHeight: 80,
    preferredHeight: 400,
  },
  "session-turns": {
    type: "session-turns",
    description:
      "The turn index for a conversation, merging the server-side turn index with loaded messages so it shows the whole session's shape rather than only what is loaded. Publishes `turnSeq`, which `session-turn` reads — that one key is the entire coupling.",
    config: [
      { name: "orientation", type: '"vertical" | "horizontal"', description: "A rail down the side, or a strip across." },
      { name: "labels", type: "boolean", description: "Show the prompt's first line beside each mark. Labels are up to 80 characters, so a labelled rail needs a bounded width." },
      { name: "sessionId", type: "string", description: "Pin to a session instead of reading page context." },
    ],
    zones: ["left-panel", "right-panel"],
    minHeight: 120,
    preferredHeight: 420,
  },
  "session-web": {
    type: "session-web",
    description: "Session relationship graph. Self-contained — fetches its own data.",
    minHeight: 300,
    preferredHeight: 600,
  },
  "session-terminal": {
    type: "session-terminal",
    zones: ["left-panel", "right-panel"],
    minHeight: 150,
    preferredHeight: 300,
    handles: [
      { type: "open-terminal", hooks: ["open", "focus", "expand"] },
      { type: "focus-widget", hooks: ["focus"] },
    ],
  },
  "sessions": {
    type: "sessions",
    description: "Sortable session list with an archived mode.",
    config: [
      { name: "filter", type: "string", description: 'e.g. "all".' },
      { name: "limit", type: "number", description: "Max rows." },
      { name: "sort", type: "{ key, dir }", description: "Sort column and direction." },
    ],
    minHeight: 120,
    preferredHeight: 220,
  },
  "stats": {
    type: "stats",
    description: "Cost, session counts, project and agent breakdowns, activity.",
    minHeight: 100,
    preferredHeight: 220,
  },
  "terminals": {
    type: "terminals",
    minHeight: 120,
    preferredHeight: 240,
  },
  "trace-viewer": {
    type: "trace-viewer",
    description: "3D file-touch trace visualization. Self-contained, no session binding.",
    minHeight: 300,
    preferredHeight: 600,
  },
  "tts-settings": {
    type: "tts-settings",
    zones: ["dashboard", "left-panel", "right-panel"],
    minHeight: 180,
    preferredHeight: 420,
  },
};

/** Widget types with no written description, for the generated catalog's gap list. */
export const UNDESCRIBED_WIDGETS: string[] = Object.keys(WIDGET_META)
  .filter((type) => !WIDGET_META[type]?.description)
  .sort();
