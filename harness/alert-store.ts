/**
 * Durable alert outbox.
 *
 * Alerts are transport-neutral records. Delivery adapters (webhook, Discord,
 * Web Push, native desktop, and so on) consume delivery rows without changing
 * the originating action or agent. Every public record lookup is Space-scoped:
 * user profiles are presentation/configuration scopes, not privacy boundaries.
 */

import { Database } from "bun:sqlite";
import { resolveDatabasePath } from "./database-paths";

export type AlertPriority = "low" | "normal" | "high" | "critical";
export type AlertSensitivity = "public" | "personal" | "sensitive";
export type AlertState = "pending" | "delivered" | "acknowledged" | "cancelled";
export type AlertDeliveryState = "pending" | "delivered" | "failed";

export type AlertIntent = {
  id?: string;
  spaceId: string;
  source: string;
  topic?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  priority?: AlertPriority;
  sensitivity?: AlertSensitivity;
  deliverAt?: number;
  expiresAt?: number | null;
  requiresAck?: boolean;
  collapseKey?: string | null;
};

export type AlertRow = {
  id: string;
  space_id: string;
  source: string;
  topic: string | null;
  title: string;
  body: string;
  data_json: string;
  priority: AlertPriority;
  sensitivity: AlertSensitivity;
  state: AlertState;
  deliver_at: number;
  expires_at: number | null;
  requires_ack: number;
  collapse_key: string | null;
  created_at: number;
  updated_at: number;
  acknowledged_at: number | null;
};

export type AlertDeliveryRow = {
  id: number;
  alert_id: string;
  channel: string;
  state: AlertDeliveryState;
  attempt_count: number;
  next_attempt_at: number;
  last_attempt_at: number | null;
  delivered_at: number | null;
  error: string | null;
};

export type DueAlertDelivery = AlertDeliveryRow & {
  space_id: string;
  source: string;
  topic: string | null;
  title: string;
  body: string;
  data_json: string;
  priority: AlertPriority;
  sensitivity: AlertSensitivity;
  expires_at: number | null;
  requires_ack: number;
};

function requireValue(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

export class AlertStore {
  constructor(private readonly db: Database) {
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id              TEXT PRIMARY KEY,
        space_id        TEXT NOT NULL,
        source          TEXT NOT NULL,
        topic           TEXT,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL,
        data_json       TEXT NOT NULL DEFAULT '{}',
        priority        TEXT NOT NULL DEFAULT 'normal',
        sensitivity     TEXT NOT NULL DEFAULT 'personal',
        state           TEXT NOT NULL DEFAULT 'pending',
        deliver_at      INTEGER NOT NULL,
        expires_at      INTEGER,
        requires_ack    INTEGER NOT NULL DEFAULT 0,
        collapse_key    TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        acknowledged_at INTEGER
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS alert_deliveries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id        TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
        channel         TEXT NOT NULL,
        state           TEXT NOT NULL DEFAULT 'pending',
        attempt_count   INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        delivered_at    INTEGER,
        error           TEXT,
        UNIQUE(alert_id, channel)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_space_created ON alerts(space_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_alert_deliveries_due ON alert_deliveries(state, next_attempt_at)`);
  }

  enqueue(intent: AlertIntent, channels: string[], now = Date.now()): AlertRow {
    const spaceId = requireValue(intent.spaceId, "spaceId");
    const source = requireValue(intent.source, "source");
    const title = requireValue(intent.title, "title");
    const body = requireValue(intent.body, "body");
    const routes = Array.from(new Set(channels.map((channel) => channel.trim()).filter(Boolean)));
    if (routes.length === 0) throw new Error("at least one delivery channel is required");

    const id = intent.id ?? crypto.randomUUID();
    const deliverAt = intent.deliverAt ?? now;
    if (intent.expiresAt != null && intent.expiresAt <= deliverAt) {
      throw new Error("expiresAt must be later than deliverAt");
    }

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO alerts (
          id, space_id, source, topic, title, body, data_json, priority,
          sensitivity, state, deliver_at, expires_at, requires_ack,
          collapse_key, created_at, updated_at, acknowledged_at
        ) VALUES (
          $id, $space_id, $source, $topic, $title, $body, $data_json, $priority,
          $sensitivity, 'pending', $deliver_at, $expires_at, $requires_ack,
          $collapse_key, $created_at, $updated_at, NULL
        )
      `).run({
        $id: id,
        $space_id: spaceId,
        $source: source,
        $topic: intent.topic?.trim() || null,
        $title: title,
        $body: body,
        $data_json: JSON.stringify(intent.data ?? {}),
        $priority: intent.priority ?? "normal",
        $sensitivity: intent.sensitivity ?? "personal",
        $deliver_at: deliverAt,
        $expires_at: intent.expiresAt ?? null,
        $requires_ack: intent.requiresAck ? 1 : 0,
        $collapse_key: intent.collapseKey?.trim() || null,
        $created_at: now,
        $updated_at: now,
      });

      const delivery = this.db.prepare(`
        INSERT INTO alert_deliveries (alert_id, channel, state, next_attempt_at)
        VALUES ($alert_id, $channel, 'pending', $next_attempt_at)
      `);
      for (const channel of routes) {
        delivery.run({ $alert_id: id, $channel: channel, $next_attempt_at: deliverAt });
      }
    });
    insert();

    return this.get(spaceId, id)!;
  }

  get(spaceId: string, id: string): AlertRow | null {
    const row = this.db.prepare(`SELECT * FROM alerts WHERE id = $id AND space_id = $space_id`)
      .get({ $id: id, $space_id: requireValue(spaceId, "spaceId") }) as AlertRow | null;
    return row ?? null;
  }

  list(spaceId: string, limit = 100): AlertRow[] {
    return this.db.prepare(`
      SELECT * FROM alerts
      WHERE space_id = $space_id
      ORDER BY created_at DESC, id DESC
      LIMIT $limit
    `).all({
      $space_id: requireValue(spaceId, "spaceId"),
      $limit: Math.max(1, Math.min(500, Math.floor(limit))),
    }) as AlertRow[];
  }

  listDeliveries(spaceId: string, alertId: string): AlertDeliveryRow[] {
    return this.db.prepare(`
      SELECT d.*
      FROM alert_deliveries d
      JOIN alerts a ON a.id = d.alert_id
      WHERE d.alert_id = $alert_id AND a.space_id = $space_id
      ORDER BY d.id ASC
    `).all({
      $alert_id: alertId,
      $space_id: requireValue(spaceId, "spaceId"),
    }) as AlertDeliveryRow[];
  }

  listDueDeliveries(now = Date.now(), limit = 50): DueAlertDelivery[] {
    return this.db.prepare(`
      SELECT d.*, a.space_id, a.source, a.topic, a.title, a.body, a.data_json,
             a.priority, a.sensitivity, a.expires_at, a.requires_ack
      FROM alert_deliveries d
      JOIN alerts a ON a.id = d.alert_id
      WHERE d.state IN ('pending', 'failed')
        AND d.next_attempt_at <= $now
        AND a.state = 'pending'
        AND (a.expires_at IS NULL OR a.expires_at > $now)
      ORDER BY d.next_attempt_at ASC, d.id ASC
      LIMIT $limit
    `).all({
      $now: now,
      $limit: Math.max(1, Math.min(500, Math.floor(limit))),
    }) as DueAlertDelivery[];
  }

  recordDeliveryResult(
    deliveryId: number,
    result: { ok: true } | { ok: false; error: string; retryAt: number },
    now = Date.now(),
  ): void {
    const update = this.db.transaction(() => {
      if (result.ok) {
        this.db.prepare(`
          UPDATE alert_deliveries
          SET state = 'delivered', attempt_count = attempt_count + 1,
              last_attempt_at = $now, delivered_at = $now, error = NULL
          WHERE id = $id
        `).run({ $id: deliveryId, $now: now });
      } else {
        this.db.prepare(`
          UPDATE alert_deliveries
          SET state = 'failed', attempt_count = attempt_count + 1,
              next_attempt_at = $retry_at, last_attempt_at = $now, error = $error
          WHERE id = $id
        `).run({
          $id: deliveryId,
          $now: now,
          $retry_at: result.retryAt,
          $error: result.error.slice(0, 1000),
        });
      }

      const row = this.db.prepare(`SELECT alert_id FROM alert_deliveries WHERE id = $id`)
        .get({ $id: deliveryId }) as { alert_id: string } | null;
      if (!row) return;
      const outstanding = this.db.prepare(`
        SELECT COUNT(*) AS count FROM alert_deliveries
        WHERE alert_id = $alert_id AND state != 'delivered'
      `).get({ $alert_id: row.alert_id }) as { count: number };
      if (outstanding.count === 0) {
        this.db.prepare(`
          UPDATE alerts SET state = 'delivered', updated_at = $now
          WHERE id = $id AND state = 'pending'
        `).run({ $id: row.alert_id, $now: now });
      }
    });
    update();
  }

  acknowledge(spaceId: string, id: string, now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE alerts
      SET state = 'acknowledged', acknowledged_at = $now, updated_at = $now
      WHERE id = $id AND space_id = $space_id AND state != 'cancelled'
    `).run({
      $id: id,
      $space_id: requireValue(spaceId, "spaceId"),
      $now: now,
    }) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  cancel(spaceId: string, id: string, now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE alerts SET state = 'cancelled', updated_at = $now
      WHERE id = $id AND space_id = $space_id AND state NOT IN ('acknowledged', 'cancelled')
    `).run({
      $id: id,
      $space_id: requireValue(spaceId, "spaceId"),
      $now: now,
    }) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }
}

let defaultStore: AlertStore | undefined;

export function getAlertStore(): AlertStore {
  if (defaultStore) return defaultStore;
  const database = new Database(resolveDatabasePath("alerts.db"));
  database.run("PRAGMA journal_mode = WAL");
  defaultStore = new AlertStore(database);
  return defaultStore;
}
