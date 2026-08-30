/**
 * queueComposerDraft — staging a prompt into a composer that does not exist yet.
 *
 * A cross-project launch creates or resumes a session, switches project, and
 * navigates; the target ChatInput mounts some renders later. Every one of those
 * steps happens before there is a handle to write to, so the draft has to
 * survive the gap. This is the same race `queueComposerAttach` already closed
 * for move chips, and the two must not clobber each other — a staged move and a
 * staged prompt arrive together.
 */

import { describe, expect, test } from "bun:test";
import { queueComposerAttach, queueComposerDraft, registerComposer } from "../../ui/src/client-extensions";
import type { MoveListItem } from "../../sdk/index";

type Recorder = {
  drafts: string[];
  focuses: number;
  attaches: Array<{ move: MoveListItem; inputs: Record<string, unknown> }>;
};

function mountComposer(id: string, opts: { attachable?: boolean; throwOnDraft?: boolean } = {}) {
  const rec: Recorder = { drafts: [], focuses: 0, attaches: [] };
  const dispose = registerComposer({
    id,
    getSnapshot: () => ({ sessionId: id, cwd: undefined, userProfile: undefined, draft: rec.drafts.at(-1) ?? "" }),
    focus: () => { rec.focuses++; },
    setDraft: (text: string) => {
      if (opts.throwOnDraft) throw new Error("boom");
      rec.drafts.push(text);
    },
    insertText: () => {},
    setGhostText: () => {},
    submit: () => {},
    ...(opts.attachable === false ? {} : {
      attachMove: (move: MoveListItem, inputs: Record<string, unknown>) => { rec.attaches.push({ move, inputs }); },
    }),
  });
  return { rec, dispose };
}

const FIXTURE_MOVE = { name: "hints", label: "Hints" } as unknown as MoveListItem;

describe("queueComposerDraft", () => {
  test("delivers immediately to a mounted composer and focuses it", () => {
    const { rec, dispose } = mountComposer("composer:mounted-1");
    queueComposerDraft("composer:mounted-1", "check in on the launcher");
    expect(rec.drafts).toEqual(["check in on the launcher"]);
    expect(rec.focuses).toBe(1);
    dispose();
  });

  test("buffers for an unmounted composer and drains on register", () => {
    queueComposerDraft("composer:later-1", "staged before mount");
    const { rec, dispose } = mountComposer("composer:later-1");
    expect(rec.drafts).toEqual(["staged before mount"]);
    expect(rec.focuses).toBe(1);
    dispose();
  });

  test("the queue is consumed once — a remount does not re-seed a draft the user cleared", () => {
    queueComposerDraft("composer:once-1", "only once");
    const first = mountComposer("composer:once-1");
    expect(first.rec.drafts).toEqual(["only once"]);
    first.dispose();

    const second = mountComposer("composer:once-1");
    expect(second.rec.drafts).toEqual([]);
    second.dispose();
  });

  test("a queued draft is discarded when its composer unmounts without ever mounting again", () => {
    // Unmounting a *different* live composer must not strand the queue, but a
    // composer that mounts and unmounts clears its own pending entry.
    const { dispose } = mountComposer("composer:evict-1");
    queueComposerDraft("composer:evict-1", "will be dropped on unmount");
    dispose();

    const second = mountComposer("composer:evict-1");
    expect(second.rec.drafts).toEqual([]);
    second.dispose();
  });

  test("a staged draft and a staged move both survive the same mount", () => {
    queueComposerDraft("composer:both-1", "the prompt");
    queueComposerAttach("composer:both-1", FIXTURE_MOVE, { query: "the prompt" });
    const { rec, dispose } = mountComposer("composer:both-1");
    expect(rec.drafts).toEqual(["the prompt"]);
    expect(rec.attaches).toHaveLength(1);
    expect(rec.attaches[0]!.inputs).toEqual({ query: "the prompt" });
    dispose();
  });

  test("routing is per composer id — one session's draft never lands in another", () => {
    queueComposerDraft("composer:a", "for a");
    const b = mountComposer("composer:b");
    expect(b.rec.drafts).toEqual([]);
    const a = mountComposer("composer:a");
    expect(a.rec.drafts).toEqual(["for a"]);
    a.dispose();
    b.dispose();
  });

  test("a throwing setDraft does not break registration", () => {
    queueComposerDraft("composer:throw-1", "boom");
    const { dispose } = mountComposer("composer:throw-1", { throwOnDraft: true });
    // Registration still returned a disposer, so the composer is live.
    expect(typeof dispose).toBe("function");
    dispose();
  });
});
