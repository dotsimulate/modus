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

import AccountWidget from "./account.widget";
import AgentActivityWidget from "./agent-activity.widget";
import ClaudePricingWidget from "./claude-pricing.widget";
import CodeEditorWidget from "./code-editor.widget";
import ConfigInspectorWidget from "./config-inspector.widget";
import DeepAnalyticsWidget from "./deep-analytics.widget";
import DefaultAgentWidget from "./default-agent.widget";
import ExtensionsWidget from "./extensions.widget";
import MovesWidget from "./moves.widget";
import PersistentTerminalWidget from "./persistent-terminal.widget";
import ProcessesWidget from "./processes.widget";
import ProfileCardWidget from "./profile-card.widget";
import ProjectThemeWidget from "./project-theme.widget";
import ProviderStatusWidget from "./provider-status.widget";
import ProviderUsageWidget from "./provider-usage.widget";
import SessionControlWidget from "./session-control.widget";
import SessionEditsWidget from "./session-edits.widget";
import SessionInfoWidget from "./session-info.widget";
import SessionListWidget from "./session-list.widget";
import SessionTerminalWidget from "./session-terminal.widget";
import SessionsWidget from "./sessions.widget";
import StatsWidget from "./stats.widget";
import TerminalsWidget from "./terminals.widget";

// ── Registry ──

export const WIDGET_DEFS: Record<string, WidgetDef> = {
  "account": {
    type: "account",
    component: AccountWidget,
    minHeight: 100,
    preferredHeight: 220,
    maxHeight: 280,
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
  "moves": {
    type: "moves",
    component: MovesWidget,
    minHeight: 100,
    preferredHeight: 220,
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
  },
  "session-terminal": {
    type: "session-terminal",
    component: SessionTerminalWidget,
    zones: ["left-panel", "right-panel"],
    minHeight: 150,
    preferredHeight: 300,
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
