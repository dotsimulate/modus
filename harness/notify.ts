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

// ── Channel Dispatch ──

async function sendToChannel(
  channel: NotificationChannel,
  channelName: string,
  message: string,
  payload: NotifyContext,
): Promise<void> {
  switch (channel.type) {
    case "webhook": {
      const method = channel.method ?? "POST";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(channel.headers ?? {}),
      };
      const body = JSON.stringify({ message, ...payload });
      const resp = await fetch(channel.url, { method, headers, body });
      if (!resp.ok) {
        console.error(`[notify] Webhook "${channelName}" returned ${resp.status}: ${await resp.text().catch(() => "")}`);
      }
      break;
    }
    case "file": {
      mkdirSync(dirname(channel.path), { recursive: true });
      const line = JSON.stringify({ timestamp: new Date().toISOString(), message, ...payload }) + "\n";
      appendFileSync(channel.path, line, "utf-8");
      break;
    }
    default:
      console.error(`[notify] Unknown channel type on "${channelName}"`);
  }
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
  const channels = getGlobalConfig().notificationChannels;
  if (!channels) return;

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

    const channel = channels[spec.channel];
    if (!channel) {
      console.error(`[notify] Channel "${spec.channel}" not found in _global.json`);
      continue;
    }

    const message = renderTemplate(spec.message ?? DEFAULT_MESSAGE, notifyCtx);

    try {
      await sendToChannel(channel, spec.channel, message, notifyCtx);
      console.log(`[notify] Sent to "${spec.channel}" for "${context.actionName}" run #${context.runNumber}`);
    } catch (err) {
      console.error(`[notify] Failed to send to "${spec.channel}":`, err);
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
  const channels = getGlobalConfig().notificationChannels;
  if (!channels) return;

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

    const channel = channels[spec.channel];
    if (!channel) continue;

    const message = renderTemplate(spec.message ?? DEFAULT_MESSAGE, notifyCtx);

    try {
      await sendToChannel(channel, spec.channel, message, notifyCtx);
      console.log(`[notify] Sent "${status}" to "${spec.channel}" for "${context.actionName}"`);
    } catch (err) {
      console.error(`[notify] Failed to send to "${spec.channel}":`, err);
    }
  }
}
