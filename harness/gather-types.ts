/**
 * Gather Context Types — the universal prompt-building contract.
 *
 * Every prompt, move, and action uses a `context.ts` with a `gather()` function.
 * gather() receives a typed context and returns a prompt string.
 *
 * The context hierarchy:
 *   BaseGatherContext        — shared I/O helpers + inputs + project
 *   ├─ PromptGatherContext   — + optional session info
 *   └─ MoveGatherContext     — + token, schema, harness bridge, DB
 *
 * Actions use their own ActionContext (in action-types.ts) which already
 * follows this pattern. Alignment is conceptual, not via inheritance.
 *
 * The inputs contract:
 *   - inputs is always Record<string, unknown> — never a bare string
 *   - Free text from chat box → inputs.text
 *   - Form fields from config JSON → inputs.<fieldName>
 */

import type { HarnessBridge, MoveDB } from "./move-types";

// ── Base ──

export interface BaseGatherContext {
  /** Form values from config JSON inputs. Always an object. */
  inputs: Record<string, unknown>;

  /** Project metadata */
  project: {
    name: string;
    slug: string;
    id?: string;
    paths: string[];
    cwd: string;
  };

  /** Working directory */
  cwd: string;

  /** Current ISO date string (YYYY-MM-DD) */
  date: string;

  // ── I/O helpers ──

  /** Read a file (relative to cwd). Returns contents or error string. */
  read(path: string): Promise<string>;

  /** Run a shell command. Returns stdout (trimmed). 10s timeout. */
  run(cmd: string): Promise<string>;

  /** Run a git command. Shorthand for run(`git ${args.join(" ")}`). */
  git(...args: string[]): Promise<string>;

  /** Attach metadata for debugging/tracing. Not part of the prompt. */
  meta(key: string, value: unknown): void;
}

// ── Prompt ──

export interface PromptGatherContext extends BaseGatherContext {
  /** Current session info, if invoked in-session */
  session?: {
    id: string;
    profile?: string;
    exchangeCount: number;
  };
}

// ── Move ──

export interface MoveGatherContext extends BaseGatherContext {
  /** Move identity */
  moveName: string;

  /** Source session ID */
  sessionId: string;

  /** Session state */
  session: {
    id: string;
    profile?: string;
    exchangeCount: number;
    lastAssistantText: string;
    seq: number;
  };

  /** Short-lived move token for modus_submit */
  token: string;

  /** Schema hint string (compact shape for the model) */
  schema: string;

  /** User profile slug */
  userProfile?: string;

  /** Harness bridge for side effects (createSession, sendMessage, etc.) */
  harness: HarnessBridge;

  /** DB access for session/move history queries */
  db: MoveDB;
}
