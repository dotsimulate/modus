/**
 * Agent profiles — server-side definitions selected by name in request body.
 *
 * Each profile maps to SDK AgentDefinition fields + extra harness-level options.
 * Frontend sends { "profile": "test-harness" } and the harness resolves it.
 */

export type Profile = {
  /** Agent system prompt */
  prompt: string;
  /** Agent description (for subagent selection) */
  description: string;
  /** Allowed tools — omit to inherit all */
  tools?: string[];
  /** Disallowed tools */
  disallowedTools?: string[];
  /** Model override */
  model?: string;
  /** Max turns override */
  maxTurns?: number;
  /** Whether to persist sessions (default true) */
  persistSession?: boolean;
  /** Effort level */
  effort?: "low" | "medium" | "high" | "max";
  /** Whether to load CLAUDE.md and project settings */
  loadProjectSettings?: boolean;
  /** System prompt mode — "custom" replaces everything, "append" adds to claude_code preset */
  promptMode?: "custom" | "append";
};

export const profiles: Record<string, Profile> = {
  /**
   * test-harness: Cheap, fast, minimal. For validating harness plumbing.
   * - Haiku model (cheapest/fastest)
   * - Read-only tools (no Bash, no Edit, no Write)
   * - Session persistence on (needed for resume across devices)
   * - No CLAUDE.md loading (pure isolation)
   * - Low effort (minimal thinking)
   * - 3 turn limit
   */
  "test-harness": {
    description: "Lightweight test agent for harness validation",
    prompt:
      "You are a minimal test agent. Respond briefly and concisely. " +
      "Do not use tools unless the user explicitly asks you to. " +
      "Keep responses under 50 words.",
    tools: ["Read", "Grep", "Glob"],
    model: "claude-haiku-4-5",
    maxTurns: 3,
    persistSession: true,
    effort: "low",
    loadProjectSettings: false,
    promptMode: "custom",
  },

  /**
   * dev-agent: The full self-learning infrastructure agent.
   * - Opus model
   * - All tools
   * - Loads CLAUDE.md (agent profile + memory system)
   * - Session persistence on
   */
  "dev-agent": {
    description: "Full self-learning agent with all tools and memory",
    prompt:
      "You are a collaborative research assistant and infrastructure builder. " +
      "Use your tools, skills, and memory system as directed by CLAUDE.md.",
    model: "claude-opus-4-6",
    persistSession: true,
    effort: "high",
    loadProjectSettings: true,
    promptMode: "append",
  },

  /**
   * research: Read-only research agent. Can search and read but not modify.
   * - Sonnet model (good balance of cost/capability)
   * - No write/edit/bash tools
   * - Loads CLAUDE.md for memory access
   */
  research: {
    description: "Read-only research agent — searches and reads, never modifies",
    prompt:
      "You are a research assistant. Search, read, and analyze — but never modify files. " +
      "Summarize findings clearly. Cite file paths and line numbers.",
    tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Agent"],
    model: "claude-sonnet-4-6",
    maxTurns: 15,
    persistSession: true,
    effort: "high",
    loadProjectSettings: true,
    promptMode: "append",
  },
};

/** Resolve a profile name to its definition, or return undefined */
export function getProfile(name: string): Profile | undefined {
  return profiles[name];
}
