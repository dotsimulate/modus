/**
 * Widget registry — binds React components onto the metadata in `catalog.ts`.
 *
 * Each widget file exports only its React component as default. Everything
 * else about a widget — description, config keys, zones, height constraints,
 * intents — lives in `catalog.ts`, which imports no components and can
 * therefore be read by the page linter and the docs generator without pulling
 * React into a test process.
 *
 * To add a new widget:
 *   1. Create widgets/my-thing.widget.tsx exporting a component as default
 *   2. Add a WIDGET_META entry in catalog.ts
 *   3. Import the component here and add it to WIDGET_COMPONENTS
 *
 * `widgetCatalog.test.ts` fails if steps 2 and 3 disagree.
 */

import type { ComponentType } from "react";
import type { WidgetDef, WidgetProps, WidgetBase, DashboardConfig } from "./types";
import { WIDGET_META } from "./catalog";

// ── Widget component imports ──

import AboutWidget from "./about.widget";
import ActionCardWidget from "./action-card.widget";
import AccountWidget from "./account.widget";
import ActionsManagerWidget from "./actions-manager.widget";
import AgentActivityWidget from "./agent-activity.widget";
import ArtifactShelfWidget from "./artifact-shelf.widget";
import ClaudePricingWidget from "./claude-pricing.widget";
import CodeEditorWidget from "./code-editor.widget";
import ComposerWidget from "./composer.widget";
import ConversationProjectionWidget from "./conversation-projection.widget";
import ConversationTranscriptWidget from "./conversation-transcript.widget";
import ConfigBarWidget from "./config-bar.widget";
import ConfigInspectorWidget from "./config-inspector.widget";
import DeepAnalyticsWidget from "./deep-analytics.widget";
import DocsWidget from "./docs.widget";
import DefaultAgentWidget from "./default-agent.widget";
import ExtensionsWidget from "./extensions.widget";
import InboxWidget from "./inbox.widget";
import MissionGraphWidget from "./mission-graph.widget";
import MissionsWidget from "./missions.widget";
import MovesWidget from "./moves.widget";
import NewSessionWidget from "./new-session.widget";
import NotesWidget from "./notes.widget";
import PagesBrowserWidget from "./pages-browser.widget";
import PersistentTerminalWidget from "./persistent-terminal.widget";
import ProcessesWidget from "./processes.widget";
import ProfileCardWidget from "./profile-card.widget";
import ProfilesManagerWidget from "./profiles-manager.widget";
import ProjectThemeWidget from "./project-theme.widget";
import ProviderStatusWidget from "./provider-status.widget";
import ProviderUsageWidget from "./provider-usage.widget";
import HintsLauncherWidget from "./hints-launcher.widget";
import SessionChatWidget from "./session-chat.widget";
import SessionControlWidget from "./session-control.widget";
import SessionEditsWidget from "./session-edits.widget";
import SessionHistoryWidget from "./session-history.widget";
import SessionInfoWidget from "./session-info.widget";
import SessionListWidget from "./session-list.widget";
import SessionSidebarWidget from "./session-sidebar.widget";
import SessionStreamsWidget from "./session-streams.widget";
import SessionTurnWidget from "./session-turn.widget";
import SessionTurnsWidget from "./session-turns.widget";
import SessionWebWidget from "./session-web.widget";
import SessionTerminalWidget from "./session-terminal.widget";
import SessionsWidget from "./sessions.widget";
import StatsWidget from "./stats.widget";
import TerminalsWidget from "./terminals.widget";
import TraceViewerWidget from "./trace-viewer.widget";
import TtsSettingsWidget from "./tts-settings.widget";

// ── Component bindings ──

export const WIDGET_COMPONENTS: Record<string, ComponentType<WidgetProps<any>>> = {
  "about": AboutWidget,
  "action-card": ActionCardWidget,
  "account": AccountWidget,
  "actions-manager": ActionsManagerWidget,
  "agent-activity": AgentActivityWidget,
  "artifact-shelf": ArtifactShelfWidget,
  "claude-pricing": ClaudePricingWidget,
  "code-editor": CodeEditorWidget,
  "composer": ComposerWidget,
  "conversation-projection": ConversationProjectionWidget,
  "conversation-transcript": ConversationTranscriptWidget,
  "config-bar": ConfigBarWidget,
  "config-inspector": ConfigInspectorWidget,
  "deep-analytics": DeepAnalyticsWidget,
  "docs": DocsWidget,
  "default-agent": DefaultAgentWidget,
  "extensions": ExtensionsWidget,
  "inbox": InboxWidget,
  "mission-graph": MissionGraphWidget,
  "missions": MissionsWidget,
  "moves": MovesWidget,
  "new-session": NewSessionWidget,
  "notes": NotesWidget,
  "pages-browser": PagesBrowserWidget,
  "persistent-terminal": PersistentTerminalWidget,
  "processes": ProcessesWidget,
  "profile-card": ProfileCardWidget,
  "profiles-manager": ProfilesManagerWidget,
  "project-theme": ProjectThemeWidget,
  "provider-status": ProviderStatusWidget,
  "provider-usage": ProviderUsageWidget,
  "hints-launcher": HintsLauncherWidget,
  "session-chat": SessionChatWidget,
  "session-control": SessionControlWidget,
  "session-edits": SessionEditsWidget,
  "session-history": SessionHistoryWidget,
  "session-info": SessionInfoWidget,
  "session-list": SessionListWidget,
  "session-sidebar": SessionSidebarWidget,
  "session-streams": SessionStreamsWidget,
  "session-turn": SessionTurnWidget,
  "session-turns": SessionTurnsWidget,
  "session-web": SessionWebWidget,
  "session-terminal": SessionTerminalWidget,
  "sessions": SessionsWidget,
  "stats": StatsWidget,
  "terminals": TerminalsWidget,
  "trace-viewer": TraceViewerWidget,
  "tts-settings": TtsSettingsWidget,
};

// ── Registry ──
//
// Built from the catalog so metadata has exactly one home. A catalog entry
// with no component is skipped rather than registered broken — an undefined
// `component` would crash at render, far from the mistake that caused it.

export const WIDGET_DEFS: Record<string, WidgetDef> = Object.fromEntries(
  Object.entries(WIDGET_META)
    .filter(([type]) => WIDGET_COMPONENTS[type])
    .map(([type, meta]) => [type, { ...meta, component: WIDGET_COMPONENTS[type] }]),
);

// ── Derived maps ──

export const WIDGETS: Record<string, ComponentType<WidgetProps<any>>> = Object.fromEntries(
  Object.entries(WIDGET_DEFS).map(([key, def]) => [key, def.component]),
);

// ── Default dashboard ──

export const DEFAULT_DASHBOARD: DashboardConfig = {
  widgets: [
    {
      id: "project-theme-main",
      type: "project-theme",
      title: "project theme",
      size: "full",
      collapsed: true,
    } as WidgetBase,
    {
      id: "claude-pricing-main",
      type: "claude-pricing",
      size: "full",
      collapsed: true,
    } as WidgetBase,
    {
      id: "sessions-main",
      type: "sessions",
      size: "full",
      limit: 5,
      collapsed: true,
    } as WidgetBase,
  ],
};
