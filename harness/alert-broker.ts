/** Policy and delivery layer for durable alerts. */

import type { AlertIntent, DueAlertDelivery } from "./alert-store";
import { AlertStore } from "./alert-store";

export type AlertDeliveryResult = { ok: true } | { ok: false; error: string };
export type AlertRouteResolver = (intent: Readonly<AlertIntent>) => string[];
export type AlertDeliveryAdapter = (
  channel: string,
  delivery: Readonly<DueAlertDelivery>,
) => Promise<AlertDeliveryResult>;

export type AlertBrokerOptions = {
  store: AlertStore;
  resolveRoutes: AlertRouteResolver;
  deliver: AlertDeliveryAdapter;
  retryBaseMs?: number;
  retryMaxMs?: number;
};

/**
 * Persists intent before attempting delivery. The route resolver is the policy
 * boundary: an agent describes importance and sensitivity, while Space policy
 * chooses which transports may receive it.
 */
export class AlertBroker {
  private readonly store: AlertStore;
  private readonly resolveRoutes: AlertRouteResolver;
  private readonly deliver: AlertDeliveryAdapter;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private draining: Promise<number> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AlertBrokerOptions) {
    this.store = options.store;
    this.resolveRoutes = options.resolveRoutes;
    this.deliver = options.deliver;
    this.retryBaseMs = options.retryBaseMs ?? 30_000;
    this.retryMaxMs = options.retryMaxMs ?? 30 * 60_000;
  }

  async publish(intent: AlertIntent, now = Date.now()): Promise<string> {
    const routes = this.resolveRoutes(Object.freeze({ ...intent }));
    const alert = this.store.enqueue(intent, routes, now);
    if (alert.deliver_at <= now) await this.flush(now);
    return alert.id;
  }

  flush(now = Date.now(), limit = 50): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = this.drain(now, limit).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((error) => console.error("[alerts] delivery flush failed:", error));
    }, intervalMs);
    this.timer.unref?.();
    void this.flush().catch((error) => console.error("[alerts] startup delivery flush failed:", error));
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async drain(now: number, limit: number): Promise<number> {
    const due = this.store.listDueDeliveries(now, limit);
    for (const delivery of due) {
      let result: AlertDeliveryResult;
      try {
        result = await this.deliver(delivery.channel, delivery);
      } catch (error) {
        result = { ok: false, error: String(error) };
      }

      if (result.ok) {
        this.store.recordDeliveryResult(delivery.id, result, now);
        continue;
      }

      const retryDelay = Math.min(
        this.retryMaxMs,
        this.retryBaseMs * (2 ** Math.min(delivery.attempt_count, 10)),
      );
      this.store.recordDeliveryResult(delivery.id, {
        ok: false,
        error: result.error,
        retryAt: now + retryDelay,
      }, now);
    }
    return due.length;
  }
}
