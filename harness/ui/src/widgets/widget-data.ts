import { useEffect, useState } from "react";

type PollingOptions<T> = {
  load: () => Promise<T>;
  scopeKey: string;
  intervalMs: number;
  initialValue: T;
  enabled?: boolean;
};

type PollingResult<T> = {
  value: T;
  loading: boolean;
  refresh: () => Promise<void>;
};

/**
 * Shared widget polling helper.
 *
 * Keeps the last successful value during refreshes and only shows `loading`
 * before the first successful load. Widgets that need custom cancellation or
 * push-style updates should keep their own logic instead of forcing this hook.
 */
export function useWidgetPollingValue<T>({
  load,
  scopeKey,
  intervalMs,
  initialValue,
  enabled = true,
}: PollingOptions<T>): PollingResult<T> {
  const [value, setValue] = useState<T>(initialValue);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) return;

    let alive = true;

    const run = async (showLoading: boolean) => {
      if (showLoading && alive) setLoading(true);
      try {
        const next = await load();
        if (!alive) return;
        setValue(next);
        setLoading(false);
      } catch {
        if (!alive) return;
        setLoading(false);
      }
    };

    void run(true);
    const iv = window.setInterval(() => {
      void run(false);
    }, intervalMs);

    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [enabled, load, intervalMs, scopeKey]);

  return {
    value,
    loading,
    refresh: async () => {
      const next = await load();
      setValue(next);
      setLoading(false);
    },
  };
}
