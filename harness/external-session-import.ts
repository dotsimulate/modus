/**
 * Turn an external provider conversation into a Modus session.
 *
 * The session row carries the provider's conversation ID as
 * `provider_session_id`, which is all the provider's resume path needs: the
 * next turn runs `--resume <id>` (Claude Code) or resumes the thread (Codex) in
 * the recorded project folder, and appends to the native history.
 *
 * The visible history is written as the same events a provider emits — prompt,
 * assistant text, result — so it reconstructs like any other session, and keeps
 * reconstructing once new turns add events of their own. Semantic message rows
 * mirror them for counts and the message-table read path.
 */

import { existsSync } from "fs";
import { addEvent, db, getSession, insertMessage, upsertSession } from "./db";
import {
  readExternalTranscript,
  type ExternalSessionProvider,
  type ExternalSessionRoots,
  type ExternalTranscript,
} from "./external-sessions";

/** Every provider conversation ID Modus already holds, mapped to its Modus session. */
export function knownProviderSessions(): Map<string, string> {
  const rows = db.prepare(`SELECT id, provider_session_id FROM sessions`).all() as { id: string; provider_session_id: string | null }[];
  const known = new Map<string, string>();
  // A fresh Claude Code session runs under its Modus ID, so the ID itself is a
  // provider ID too. The persisted provider ID wins where both exist.
  for (const row of rows) known.set(row.id, row.id);
  for (const row of rows) if (row.provider_session_id) known.set(row.provider_session_id, row.id);
  return known;
}

export type ImportExternalSessionResult =
  | { ok: true; sessionId: string; existing: boolean }
  | { ok: false; status: 404 | 409; error: string };

export function importExternalSession(opts: {
  provider: ExternalSessionProvider;
  id: string;
  userProfile?: string;
  roots?: ExternalSessionRoots;
  /** Injected for tests; defaults to a fresh UUID. */
  newId?: string;
}): ImportExternalSessionResult {
  const existing = knownProviderSessions().get(opts.id);
  if (existing && getSession(existing)) return { ok: true, sessionId: existing, existing: true };

  const transcript = readExternalTranscript(opts.provider, opts.id, opts.roots);
  if (!transcript) return { ok: false, status: 404, error: `no ${opts.provider} conversation ${opts.id}` };
  if (!transcript.cwd) return { ok: false, status: 409, error: "the conversation does not record its project folder, so it cannot be resumed" };
  if (!existsSync(transcript.cwd)) return { ok: false, status: 409, error: `project folder no longer exists: ${transcript.cwd}` };
  if (!transcript.turns.some((turn) => turn.role === "user")) return { ok: false, status: 409, error: "the conversation has no prompts to continue" };

  const sessionId = opts.newId ?? crypto.randomUUID();
  writeImportedSession(sessionId, transcript, opts.userProfile);
  return { ok: true, sessionId, existing: false };
}

function writeImportedSession(sessionId: string, transcript: ExternalTranscript, userProfile?: string) {
  const turns = transcript.turns;
  const lastPrompt = [...turns].reverse().find((turn) => turn.role === "user")?.text;
  const lastResponse = [...turns].reverse().find((turn) => turn.role === "assistant")?.text;
  const firstPrompt = turns.find((turn) => turn.role === "user")?.text ?? "";
  // Turns keep their original times so the transcript reads in order; anything
  // missing a time sits just before the import.
  const importedAt = Date.now();
  const at = (timestamp: number) => (timestamp > 0 && timestamp <= importedAt ? timestamp : importedAt - 1);

  db.transaction(() => {
    // Events reference the session row.
    upsertSession({
      id: sessionId,
      preview: firstPrompt.slice(0, 200),
      title: transcript.title || undefined,
      provider: transcript.provider,
      providerSessionId: transcript.id,
      model: transcript.model,
      status: "idle",
      messageCount: turns.length,
      costUsd: 0,
      lastPrompt,
      lastResponse,
      cwd: transcript.cwd ?? undefined,
      userProfile,
    });

    let seq = 0;
    for (const turn of turns) {
      const createdAt = at(turn.timestamp);
      seq++;
      if (turn.role === "user") {
        addEvent(sessionId, seq, "user", "prompt", JSON.stringify({
          type: "user",
          subtype: "prompt",
          message: { role: "user", content: turn.text },
        }), createdAt);
        insertMessage({ sessionId, seq, role: "user", content: turn.text, createdAt });
        continue;
      }
      addEvent(sessionId, seq, "assistant", null, JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: turn.text }] },
      }), createdAt);
      seq++;
      addEvent(sessionId, seq, "result", "success", JSON.stringify({
        type: "result",
        subtype: "success",
        imported: true,
      }), createdAt);
      insertMessage({ sessionId, seq, role: "assistant", content: turn.text, model: transcript.model, createdAt });
    }

    // The stored config is what a revived session's provider is read from;
    // without it the next turn would fall back to the profile's provider.
    seq++;
    addEvent(sessionId, seq, "system", "config_updated", JSON.stringify({
      type: "system",
      subtype: "config_updated",
      model: transcript.model,
      config: { provider: transcript.provider, ...(transcript.model ? { model: transcript.model } : {}) },
      cwd: transcript.cwd,
      importedFrom: { provider: transcript.provider, id: transcript.id },
    }), importedAt);
  })();
}
