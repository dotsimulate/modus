/**
 * Notify — declarative notification dispatch for the action pipeline.
 *
 * Actions declare `notify` specs in their config. After each run finalization,
 * the action runner calls `sendNotifications` with the run result. This module
 * resolves channels from _global.json and dispatches to webhook or file.
 *
 * Failures are logged and never block the pipeline.
 */

import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getGlobalConfig, type NotificationChannel } from "./profiles";
import type { NotifySpec, RunResult } from "./action-types";
import { isChannelAllowed } from "./vault-policy";

// ── Template Rendering ──

interface NotifyContext {
  action: string;
  run: number;
  status: string;
  error: string | null;
  cost: number;
  duration: number;
  profile: string;
}

const DEFAULT_MESSAGE = "{action} run #{run}: {status}";

function renderTemplate(template: string, ctx: NotifyContext): string {
  return template
    .replace(/\{action\}/g, ctx.action)
    .replace(/\{run\}/g, String(ctx.run))
    .replace(/\{status\}/g, ctx.status)
    .replace(/\{error\}/g, ctx.error ?? "")
    .replace(/\{cost\}/g, ctx.cost > 0 ? `$${ctx.cost.toFixed(4)}` : "$0")
    .replace(/\{duration\}/g, ctx.duration > 0 ? `${Math.round(ctx.duration / 1000)}s` : "0s")
    .replace(/\{profile\}/g, ctx.profile);
}

// ── Channel Egress Primitive ──

/**
 * Render a webhook body for a channel + payload.
 *   - `bodyTemplate`: substitute `{text}` (JSON-escaped, quote-stripped so it drops
 *     inside the template's own quotes) and `{data}` (JSON object).
 *   - `contentField`: wrap text under a single key, merge `data` alongside.
 *   - default: today's shape `{ message: text, ...data }` — keeps existing webhooks unbroken.
 */
function renderWebhookBody(
  channel: Extract<NotificationChannel, { type: "webhook" }>,
  payload: { text: string; data?: Record<string, unknown> },
): string {
  const { text, data } = payload;
  if (channel.bodyTemplate) {
    const escapedText = JSON.stringify(text).slice(1, -1); // strip surrounding quotes
    const dataJson = JSON.stringify(data ?? {});
    // Function replacers — a string replacement would interpret `$&`/`$1`/`$$` inside the
    // (JSON-escaped but not $-escaped) text or data, corrupting the body.
    return channel.bodyTemplate
      .replace(/\{text\}/g, () => escapedText)
      .replace(/\{data\}/g, () => dataJson);
  }
  if (channel.contentField) {
    return JSON.stringify({ [channel.contentField]: text, ...(data ?? {}) });
  }
  return JSON.stringify({ message: text, ...(data ?? {}) });
}

/**
 * Send content to a named sink. This is the single channel-egress primitive —
 * action notifications, move bridge notify, and ctx.channels.send all route here.
 * Never throws: failures are returned as { ok: false, error }.
 */
export async function sendToChannel(
  channel: NotificationChannel,
  payload: { text: string; data?: Record<string, unknown> },
): Promise<{ ok: boolean; error?: string }> {
  switch (channel.type) {
    case "webhook": {
      const method = channel.method ?? "POST";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(channel.headers ?? {}),
      };
      const body = renderWebhookBody(channel, payload);
      try {
        const resp = await fetch(channel.url, { method, headers, body });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          return { ok: false, error: `webhook returned ${resp.status}: ${errText.slice(0, 200)}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    case "file": {
      try {
        mkdirSync(dirname(channel.path), { recursive: true });
        const line = JSON.stringify({ timestamp: new Date().toISOString(), message: payload.text, ...(payload.data ?? {}) }) + "\n";
        appendFileSync(channel.path, line, "utf-8");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    default:
      return { ok: false, error: "unknown channel type" };
  }
}

export type ChannelResolution =
  | { ok: true; channel: NotificationChannel }
  | { ok: false; error: string };

/** Resolve the authored channel name only after the current Vault permits it. */
export function resolveChannel(channelName: string, cwd?: string): ChannelResolution {
  if (!isChannelAllowed(channelName)) {
    return { ok: false, error: `Channel "${channelName}" is disabled by Vault policy` };
  }
  const channel = getGlobalConfig(cwd).notificationChannels?.[channelName];
  if (!channel) {
    return { ok: false, error: `Channel "${channelName}" not found in _global.json` };
  }
  return { ok: true, channel };
}

// ── Public API ──

/**
 * Send notifications for a completed run. Called from fireAction after finalization.
 * Matches run status against each notify spec's `on` condition and dispatches.
 */
export async function sendNotifications(
  specs: NotifySpec[],
  result: RunResult,
  context: { actionName: string; runNumber: number; profile: string },
): Promise<void> {
  const notifyCtx: NotifyContext = {
    action: context.actionName,
    run: context.runNumber,
    status: result.status,
    error: result.error,
    cost: result.costUsd,
    duration: result.durationMs,
    profile: context.profile,
  };

  for (const spec of specs) {
    const conditions = Array.isArray(spec.on) ? spec.on : [spec.on];
    if (!conditions.includes(result.status as any)) continue;

    const resolution = resolveChannel(spec.channel);
    if (!resolution.ok) {
      console.error(`[notify] ${resolution.error}`);
      continue;
    }

    const message = renderTemplate(spec.message ?? DEFAULT_MESSAGE, notifyCtx);

    const res = await sendToChannel(resolution.channel, { text: message, data: { ...notifyCtx } });
    if (res.ok) {
      console.log(`[notify] Sent to "${spec.channel}" for "${context.actionName}" run #${context.runNumber}`);
    } else {
      console.error(`[notify] Failed to send to "${spec.channel}": ${res.error}`);
    }
  }
}

/**
 * Send a notification for an action-level event (e.g., exhausted).
 * Uses the same channel resolution but with a synthetic context.
 */
export async function sendActionNotification(
  specs: NotifySpec[],
  status: string,
  context: { actionName: string; profile: string },
): Promise<void> {
  const notifyCtx: NotifyContext = {
    action: context.actionName,
    run: 0,
    status,
    error: null,
    cost: 0,
    duration: 0,
    profile: context.profile,
  };

  for (const spec of specs) {
    const conditions = Array.isArray(spec.on) ? spec.on : [spec.on];
    if (!conditions.includes(status as any)) continue;

    const resolution = resolveChannel(spec.channel);
    if (!resolution.ok) {
      console.error(`[notify] ${resolution.error}`);
      continue;
    }

    const message = renderTemplate(spec.message ?? DEFAULT_MESSAGE, notifyCtx);

    const res = await sendToChannel(resolution.channel, { text: message, data: { ...notifyCtx } });
    if (res.ok) {
      console.log(`[notify] Sent "${status}" to "${spec.channel}" for "${context.actionName}"`);
    } else {
      console.error(`[notify] Failed to send to "${spec.channel}": ${res.error}`);
    }
  }
}

// ── Channel resolution helper (shared by ctx.channels.send) ──

/**
 * Resolve a named channel and send content to it. Used by the Harness Context
 * channels namespace. Returns a structured result; never throws.
 */
export async function sendToNamedChannel(
  channelName: string,
  payload: { text: string; data?: Record<string, unknown> },
  cwd?: string,
): Promise<{ ok: boolean; error?: string }> {
  const resolution = resolveChannel(channelName, cwd);
  if (!resolution.ok) return resolution;
  return sendToChannel(resolution.channel, payload);
}
