---
title: Checkpoint, Rewind, and Branch Safety Decisions
lastUpdated: 2026-07-11
audience: dev
covers: harness/checkpoints.ts harness/checkpoint-maintenance.ts
---

# Checkpoint, Rewind, and Branch Safety Decisions

Date: 2026-07-11

Status: implemented foundation; provider expansion, retention, and destructive-path
integration tests remain before release approval.

This is a dated design record. Its provider availability notes reflect July 2026;
see [Providers](providers.md) for the current distributed app.

## Outcome

Modus now treats three different facts as three different systems:

1. Conversation branching is a provider capability.
2. Workspace rewind is either provider-native or a bounded Modus checkpoint.
3. File/tool provenance is observability and never grants authority to undo.

This separation is the central product decision. A copied transcript is not a
provider branch, a tool call is not proof of every resulting file change, and a
partial snapshot is not an arbitrary workspace reset.

## User-facing behavior

Branch and rewind controls remain near the user message, but neither executes on
the first click. The first click opens a review dialog. The dialog shows:

- the conversation provider and verified branch capability;
- whether workspace rewind is native Claude or Modus-managed;
- every path the operation says it will change;
- whether each Modus path will be restored or deleted;
- excluded paths that are explicitly protected;
- shared-workspace and provider-boundary warnings; and
- whether an undo checkpoint will be available.

The confirmation button is disabled when conversation branching or the requested
workspace rewind is unsupported. The server also requires `confirmed: true`, so
bypassing the UI does not turn a preview endpoint into a destructive endpoint.

After a rewind, a persistent notice offers `Review undo`. That performs a fresh
preview of the undo checkpoint. Undo has a second, separate confirmation button.

## Conversation branch decision

The currently enabled conversation branch is Claude Code's native message fork.
The existing adapter already passes `forkSession`, the parent session ID, and
`resumeSessionAt` to the Claude Agent SDK. Modus now advertises that operation as
`native-message` only when it has the provider assistant-message UUID needed for
the fork.

Cursor transcript copying is no longer treated as a branch. It is reported as
`transcript-copy` but unsupported by the branch action. Other providers are also
disabled until their actual native/history implementation is wired. This is
intentionally stricter than creating a visually convincing chat that starts with
degraded or missing provider context.

Copied semantic-message count now becomes the new branch's `message_count`.
Event sequence number and source-tip count are not used as substitutes.

## Claude native file rewind

The Claude adapter enables `enableFileCheckpointing`, preserves new Claude user
message UUIDs, and implements:

- `Query.rewindFiles(userMessageId, { dryRun: true })` for review; and
- `Query.rewindFiles(userMessageId)` for application.

The UI uses the exact `filesChanged` paths returned by Claude. These are labeled
`native-provider`, not inferred Modus paths. The dialog also states the documented
boundary: edits made indirectly through shell commands may not be included in
Claude's SDK file checkpoint.

Modus can only use this native operation while the Claude query control channel
is genuinely available. The current provider lifecycle closes that channel after
an idle turn to prevent known Windows ghost-process leaks. When native dry-run is
unavailable, Modus uses its own bounded checkpoint and labels it `modus`; it does
not claim that Claude performed the rewind.

Before applying a native Claude rewind, Modus captures a bounded safety checkpoint.
If that safety capture fails, native rewind is refused. This provides a reviewed
undo for the managed subset without pretending it covers paths excluded by size
or scope limits.

## Modus checkpoint decision

The prototype used a bare shadow repository plus `git add -A` and restored with
`reset --hard`. That design was rejected because it could ingest arbitrary large
untracked files and reset the whole shared worktree. One observed shadow store
reached roughly 34.1 GiB in four commits.

The replacement still uses Git objects for content deduplication, but builds an
empty index and stages only explicit manifest paths. Defaults are:

- maximum file size: 16 MiB;
- maximum total managed bytes per snapshot: 256 MiB;
- ignored paths: not candidates;
- oversized, unreadable, directory, unsafe, and total-limit paths: recorded as
  exclusions and protected during restore; and
- legacy checkpoints without the v2 manifest: previewed as unsupported and never
  restored.

Capture now settles before the provider is started or receives a queued user
message. Capture failure may allow the agent turn to continue, but Modus does not
record that failed capture as a usable checkpoint. This removes the old race in
which a fast tool edit could occur before the supposedly pre-turn snapshot.

Restore never runs `reset --hard`, `checkout .`, or another whole-tree command.
It checks out only explicit `restore` paths from the selected shadow commit and
unlinks only explicit managed `delete` paths. Ignored files, exclusions, nested
repositories/directories, and other paths outside the manifest are left alone.

Immediately before restore, Modus captures current managed state and records it as
an undo checkpoint. Both restore and undo are serialized per workspace.

## Why not use the main repository

Using commits, stash, or reset in the user's main Git repository was rejected.
Those mechanisms can modify the user's index, refs, stash list, or whole tree and
interfere with independent Git work. The shadow repository keeps Modus metadata
separate while explicit-path restore keeps its workspace authority narrow.

## Why not infer undo from tool calls

Providers can write through explicit file tools, shells, subprocesses, MCP tools,
formatters, hooks, or external programs. A tool name and declared path are useful
provenance but are not a complete causal record.

Modus now stores explicit file-tool declarations in `file_observations` with the
session, sequence, provider, tool-call ID, tool name, path, operation, timestamp,
and evidence label `provider-tool-declared`. The API describes this ledger as
`observability-only`. It is not consulted by checkpoint preview or restore.

Shell command observation, filesystem-watcher correlation, result status/hashes,
provider-authoritative Codex/OpenCode diffs, and a dedicated per-turn provenance
panel remain follow-up work.

## Provider choices and implementation status

- Codex: migrate to app-server and use `thread/fork`; consume native file-change
  items for observability, but do not claim workspace rollback.
- OpenCode: use server `/fork`, `/diff`, `/revert`, and `/unrevert` rather than a
  second Modus rollback layer.
- Antigravity: implemented as a distinct documented adapter and Google's primary
  consumer-facing terminal provider. Native UUID resume and Hook-based tool
  observability are wired; TUI-only fork/rewind remain unsupported here.
- Gemini CLI: retained only as explicitly supported hidden legacy migration code;
  OAuth piggybacking is removed and auth mode now matches explicit API/Vertex/ADC
  configuration.
- PI providers: wire Modus-owned history explicitly before advertising
  `modus-history` branching.
- Cursor: if retained, expose transcript seeding under a different product name,
  not branch or rewind.

## Known remaining warning areas

1. Retention, GC, repository-wide storage caps, and storage UI are not implemented.
   The existing approximately 36.6 GB checkpoint store has deliberately not been
   changed or deleted and requires a separate migration/cleanup decision.
2. Automated destructive-path integration tests are still required: tracked edits,
   new untracked files, deletion, ignored/oversized protection, symlinks, nested
   repositories, interrupted restore, concurrent capture, and undo/redo.
3. A restore can partially apply if an OS/filesystem error occurs after some
   explicit paths have changed. The pre-restore undo checkpoint remains available,
   but transactional filesystem replacement is not yet implemented.
4. Snapshot collection is byte-bounded but not yet time-bounded.
5. New user-message UUID preservation enables Claude native rewind going forward;
   old semantic user rows without UUIDs use the Modus fallback.
6. Backend type-checking still reports two pre-existing room-context errors at
   `moves/room/context.ts`; the checkpoint/branch/UI changes introduce no additional
   TypeScript errors.

## Release gate

This foundation should not be called fully release-approved until the remaining
destructive-path tests, retention/storage controls, and provider-specific adapters
are completed. It is, however, materially safer than the prototype: whole-tree
reset is gone, large arbitrary capture is bounded, capability claims are enforced,
effects are visible before confirmation, and undo is explicit.
