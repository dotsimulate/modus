/**
 * Widget registry — explicit registration of all built-in widgets.
 *
 * Each widget file exports only its React component as default.
 * Metadata (type, zones, height constraints) is declared here.
 *
 * To add a new widget:
 *   1. Create widgets/my-thing.widget.tsx exporting a component as default
 *   2. Import it here and add an entry to WIDGET_DEFS
 */

import type { ComponentType } from "react";
import type { WidgetDef, WidgetProps, WidgetBase, DashboardConfig } from "./types";

// ── Widget component imports ──

import ActionCardWidget from "./action-card.widget";
import AccountWidget from "./account.widget";
import ActionsManagerWidget from "./actions-manager.widget";
import AgentActivityWidget from "./agent-activity.widget";
import ClaudePricingWidget from "./claude-pricing.widget";
import CodeEditorWidget from "./code-editor.widget";
import ComposerWidget from "./composer.widget";
import ConfigBarWidget from "./config-bar.widget";
import ConfigInspectorWidget from "./config-inspector.widget";
import DeepAnalyticsWidget from "./deep-analytics.widget";
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
import SessionWebWidget from "./session-web.widget";
import SessionTerminalWidget from "./session-terminal.widget";
import SessionsWidget from "./sessions.widget";
import StatsWidget from "./stats.widget";
import TerminalsWidget from "./terminals.widget";
import TraceViewerWidget from "./trace-viewer.widget";

// ── Registry ──

export const WIDGET_DEFS: Record<string, WidgetDef> = {
  "action-card": {
    type: "action-card",
    component: ActionCardWidget,
    minHeight: 80,
    preferredHeight: 150,
    maxHeight: 200,
  },
  "account": {
    type: "account",
    component: AccountWidget,
    minHeight: 100,
    preferredHeight: 220,
    maxHeight: 280,
  },
  "actions-manager": {
    type: "actions-manager",
    component: ActionsManagerWidget,
    minHeight: 200,
    preferredHeight: 500,
    handles: ["open-terminal"],
  },
  "agent-activity": {
    type: "agent-activity",
    component: AgentActivityWidget,
    zones: ["left-panel", "right-panel"],
    minHeight: 100,
    preferredHeight: 250,
  },
  "claude-pricing": {
    type: "claude-pricing",
    component: ClaudePricingWidget,
    minHeight: 100,
    preferredHeight: 220,
  },
  "code-editor": {
    type: "code-editor",
    component: CodeEditorWidget,
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
    component: ComposerWidget,
    minHeight: 60,
    preferredHeight: 120,
    maxHeight: 200,
  },
  "config-bar": {
    type: "config-bar",
    component: ConfigBarWidget,
    minHeight: 30,
    preferredHeight: 40,
    maxHeight: 300,
  },
  "config-inspector": {
    type: "config-inspector",
    component: ConfigInspectorWidget,
    minHeight: 60,
    preferredHeight: 160,
    maxHeight: 240,
  },
  "deep-analytics": {
    type: "deep-analytics",
    component: DeepAnalyticsWidget,
    minHeight: 140,
    preferredHeight: 280,
  },
  "default-agent": {
    type: "default-agent",
    component: DefaultAgentWidget,
    minHeight: 60,
    preferredHeight: 160,
    maxHeight: 220,
  },
  "extensions": {
    type: "extensions",
    component: ExtensionsWidget,
    minHeight: 100,
    preferredHeight: 220,
  },
  "inbox": {
    type: "inbox",
    component: InboxWidget,
    minHeight: 150,
    preferredHeight: 400,
  },
  "mission-graph": {
    type: "mission-graph",
    component: MissionGraphWidget,
    minHeight: 300,
    preferredHeight: 600,
  },
  "missions": {
    type: "missions",
    component: MissionsWidget,
    minHeight: 200,
    preferredHeight: 500,
  },
  "moves": {
    type: "moves",
    component: MovesWidget,
    minHeight: 100,
    preferredHeight: 220,
    handles: ["open-move", "close-move"],
  },
  "new-session": {
    type: "new-session",
    component: NewSessionWidget,
    minHeight: 200,
    preferredHeight: 400,
  },
  "notes": {
    type: "notes",
    component: NotesWidget,
    zones: ["left-panel", "right-panel", "dashboard"],
    minHeight: 220,
    preferredHeight: 560,
  },
  "pages-browser": {
    type: "pages-browser",
    component: PagesBrowserWidget,
    zones: ["dashboard", "left-panel", "right-panel"],
    minHeight: 160,
    preferredHeight: 400,
  },
  "persistent-terminal": {
    type: "persistent-terminal",
    component: PersistentTerminalWidget,
    zones: ["left-panel", "right-panel", "dashboard"],
    minHeight: 150,
    preferredHeight: 300,
  },
  "processes": {
    type: "processes",
    component: ProcessesWidget,
    minHeight: 100,
    preferredHeight: 220,
  },
  "profile-card": {
    type: "profile-card",
    component: ProfileCardWidget,
    minHeight: 80,
    preferredHeight: 180,
    maxHeight: 240,
  },
  "profiles-manager": {
    type: "profiles-manager",
    component: ProfilesManagerWidget,
    minHeight: 200,
    preferredHeight: 500,
  },
  "project-theme": {
    type: "project-theme",
    component: ProjectThemeWidget,
    minHeight: 120,
    preferredHeight: 220,
  },
  "provider-status": {
    type: "provider-status",
    component: ProviderStatusWidget,
    minHeight: 80,
    preferredHeight: 180,
    maxHeight: 240,
  },
  "provider-usage": {
    type: "provider-usage",
    component: ProviderUsageWidget,
    minHeight: 100,
    preferredHeight: 220,
  },
  "hints-launcher": {
    type: "hints-launcher",
    component: HintsLauncherWidget,
    zones: ["dashboard", "left-panel", "right-panel"],
    minHeight: 180,
    preferredHeight: 360,
  },
  "session-chat": {
    type: "session-chat",
    component: SessionChatWidget,
    minHeight: 200,
    preferredHeight: 500,
  },
  "session-control": {
    type: "session-control",
    component: SessionControlWidget,
    minHeight: 80,
    preferredHeight: 150,
    maxHeight: 220,
  },
  "session-edits": {
    type: "session-edits",
    component: SessionEditsWidget,
    zones: ["left-panel", "right-panel"],
    minHeight: 100,
    preferredHeight: 250,
  },
  "session-history": {
    type: "session-history",
    component: SessionHistoryWidget,
    minHeight: 200,
    preferredHeight: 400,
  },
  "session-info": {
    type: "session-info",
    component: SessionInfoWidget,
    minHeight: 60,
    preferredHeight: 180,
    maxHeight: 260,
  },
  "session-list": {
    type: "session-list",
    component: SessionListWidget,
    minHeight: 160,
    preferredHeight: 320,
    handles: [
      { type: "select-session", hooks: ["activate"] },
    ],
  },
  "session-sidebar": {
    type: "session-sidebar",
    component: SessionSidebarWidget,
    minHeight: 150,
    preferredHeight: 300,
  },
  "session-web": {
    type: "session-web",
    component: SessionWebWidget,
    minHeight: 300,
    preferredHeight: 600,
  },
  "session-terminal": {
    type: "session-terminal",
    component: SessionTerminalWidget,
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
    component: SessionsWidget,
    minHeight: 120,
    preferredHeight: 220,
  },
  "stats": {
    type: "stats",
    component: StatsWidget,
    minHeight: 100,
    preferredHeight: 220,
  },
  "terminals": {
    type: "terminals",
    component: TerminalsWidget,
    minHeight: 120,
    preferredHeight: 240,
  },
  "trace-viewer": {
    type: "trace-viewer",
    component: TraceViewerWidget,
    minHeight: 300,
    preferredHeight: 600,
  },
};

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
    } as WidgetBase,
    {
      id: "claude-pricing-main",
      type: "claude-pricing",
      size: "full",
    } as WidgetBase,
    {
      id: "deep-analytics-main",
      type: "deep-analytics",
      title: "deep analytics",
      size: "full",
    } as WidgetBase,
    {
      id: "sessions-main",
      type: "sessions",
      size: "full",
      limit: 5,
    } as WidgetBase,
  ],
};
