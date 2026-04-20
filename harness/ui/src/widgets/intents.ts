import { useCallback } from "react";
import type { ActivateMoveResult, AttachMoveResult } from "../../../sdk/index";
import type { LayoutNode, PageContextHandle, UiIntent, UiIntentCapability, UiIntentObserver, UiIntentType, WidgetBase, WidgetDef } from "./types";

type UiIntentEmitter = Pick<PageContextHandle, "emit" | "observeIntents">;

export function dispatchUiIntent(emitter: Pick<PageContextHandle, "emit"> | null | undefined, intent: UiIntent): void {
  emitter?.emit(intent);
}

export function useUiIntent(pageContext?: UiIntentEmitter) {
  const dispatch = useCallback((intent: UiIntent) => {
    pageContext?.emit(intent);
  }, [pageContext]);

  const observe = useCallback((handler: UiIntentObserver): (() => void) => {
    return pageContext?.observeIntents(handler) ?? (() => {});
  }, [pageContext]);

  return { dispatch, observe };
}

export function moveAttachResultToIntent(
  result: AttachMoveResult,
  sessionId: string,
): UiIntent | null {
  if (!result.widget || !result.apiToken || !result.instanceId) return null;
  return {
    type: "open-move",
    id: `widget:${result.instanceId}`,
    label: result.widget.label,
    widget: result.widget,
    apiToken: result.apiToken,
    instanceId: result.instanceId,
    sessionId,
    mountedOnAttach: result.widget.mountOnAttach ?? true,
  };
}

export function moveActivationResultToIntent(
  result: ActivateMoveResult,
  sourceSessionId: string,
): UiIntent | null {
  if (!result.widget || !result.apiToken || !result.instanceId) return null;
  return {
    type: "open-move",
    id: `widget:${result.instanceId}`,
    label: result.widget.label,
    widget: result.widget,
    apiToken: result.apiToken,
    instanceId: result.instanceId,
    sessionId: result.spawnedSessionId ?? sourceSessionId,
    mountedOnAttach: result.widget.mountOnAttach ?? false,
  };
}

export function normalizeIntentCapability(
  capability: UiIntentType | UiIntentCapability,
): UiIntentCapability {
  return typeof capability === "string" ? { type: capability } : capability;
}

export function getWidgetIntentCapabilities(
  widget: WidgetBase,
  widgetDef?: WidgetDef,
): UiIntentCapability[] {
  return [
    ...(widgetDef?.handles ?? []),
    ...(widget.handles ?? []),
  ].map(normalizeIntentCapability);
}

function capabilityMatchesIntent(capability: UiIntentCapability, intent: UiIntent): boolean {
  if (capability.type !== intent.type) return false;
  if (capability.target && capability.target !== intent.target) return false;
  return true;
}

export function widgetHandlesIntent(
  widget: WidgetBase,
  widgetDef: WidgetDef | undefined,
  intentType: UiIntentType,
): boolean {
  return getWidgetIntentCapabilities(widget, widgetDef).some((capability) => capability.type === intentType);
}

export function widgetHandlesUiIntent(
  widget: WidgetBase,
  widgetDef: WidgetDef | undefined,
  intent: UiIntent,
): boolean {
  return getWidgetIntentCapabilities(widget, widgetDef).some((capability) => capabilityMatchesIntent(capability, intent));
}

export function getPanelIntentCapabilities(
  node: Extract<LayoutNode, { kind: "tabs" | "list" }>,
): UiIntentCapability[] {
  return (node.handles ?? []).map(normalizeIntentCapability);
}

export function panelHandlesIntent(
  node: Extract<LayoutNode, { kind: "tabs" | "list" }>,
  intentType: UiIntentType,
): boolean {
  return getPanelIntentCapabilities(node).some((capability) => capability.type === intentType);
}

export function panelHandlesUiIntent(
  node: Extract<LayoutNode, { kind: "tabs" | "list" }>,
  intent: UiIntent,
): boolean {
  return getPanelIntentCapabilities(node).some((capability) => capabilityMatchesIntent(capability, intent));
}
