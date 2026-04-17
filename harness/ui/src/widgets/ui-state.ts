import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { WidgetBase } from "./types";

type Scope = {
  userProfile?: string | null;
  cwd?: string;
};

function safePart(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? encodeURIComponent(trimmed) : fallback;
}

export function getWidgetInstanceId(config: WidgetBase, index: number): string {
  return config.id?.trim() || `${config.type}-${index}`;
}

function getStorageKey(scope: Scope, widgetId: string, field: string): string {
  const user = safePart(scope.userProfile, "anon");
  const cwd = safePart(scope.cwd, "global");
  return `harness:widget-ui:${user}:${cwd}:${widgetId}:${field}`;
}

function loadValue<T>(storageKey: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function useWidgetUiState<T>(
  scope: Scope,
  widgetId: string,
  field: string,
  fallback: T,
): [T, Dispatch<SetStateAction<T>>] {
  const storageKey = getStorageKey(scope, widgetId, field);
  const [value, setValue] = useState<T>(() => loadValue(storageKey, fallback));

  useEffect(() => {
    setValue(loadValue(storageKey, fallback));
  }, [storageKey, fallback]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {}
  }, [storageKey, value]);

  return [value, setValue];
}
