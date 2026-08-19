---
title: Config Resolution
lastUpdated: 2026-08-19
lastCommit: a9adf68
covers: harness/profiles.ts harness/profile-schemas.ts harness/session-manager.ts harness/providers/pi-agent.ts harness/vault-policy.ts harness/modus-plugins.ts
---

# Config Resolution

Every runtime value in the harness resolves through a layered chain. The first
non-undefined value wins. No layer is required — the system works with zero config.

## Resolution Order

```
profile JSON  →  _global.json providerDefaults  →  TypeScript fallback
(per-agent)      (per-provider, all agents)         (hardcoded, invisible)
```

**Profile JSON** (`<current-home>/profiles/agents/<name>.json`, or
`<cwd>/.modus/profiles/agents/<name>.json`): Per-agent overrides. A creative
agent might want a smaller context window to force earlier compaction. A coding agent
might want compaction disabled entirely.

`<current-home>` is Main's Modus home for Main and the registered folder root
for a named Vault. Each Vault therefore has its own profile catalog, global
config, prompt cache, and UI state. A named process never consults Main's
profile tree; see [Vaults](./vaults.md).

**Provider Defaults** (`<current-home>/profiles/_global.json` and project
`<cwd>/.modus/_global.json` → `providerDefaults.<provider>`):
Per-provider overrides. If your llama-server runs `-c 65536`, set it once here and
every `openai-compat` agent inherits it. Optional — most users never touch this.

Enabled plugins contribute `.modus/_global.json` between those two writable
layers. For MCP servers, provider defaults, notifications, and client-extension
config, the merge order is:

```
built-in → current-Vault _global.json → enabled plugin _global.json files
         → project _global.json → agent profile
```

Later layers win per key. Plugin registration order determines ordering between
enabled plugins. Each Vault has its own `plugins.json`; its `plugins` policy
then filters those locally registered references before plugin configuration
contributes to the merge. A new named Vault starts with no plugin registration.

**TypeScript fallback** (in `pi-agent.ts`): Ships with sane defaults. 128000 context
(or API-provided for openrouter), 8192 max output, compaction enabled with
`Math.max(4096, model.maxTokens)` reserve and 20000 keep-recent.

## What's Configurable

| Field | Profile | Provider Default | TS Fallback | Notes |
|-------|---------|-----------------|-------------|-------|
| `contextWindow` | ✓ | ✓ | 128000 (or openrouter API) | Must match your inference server's `-c` flag for local models |
| `maxOutputTokens` | ✓ | ✓ | 8192 | Max tokens per response |
| `compaction.enabled` | ✓ | ✓ | true | Threshold compaction at ~75% context usage |
| `compaction.reserveTokens` | ✓ | ✓ | max(4096, maxOutputTokens) | Tokens reserved for the next response |
| `compaction.keepRecentTokens` | ✓ | ✓ | 20000 | Recent context preserved during compaction |

## Examples

### Zero config (just works)
```json
{
  "provider": "openai-compat",
  "model": "glm-4.7-flash",
  "prompt": "You are a coding assistant."
}
```
Uses all TypeScript defaults. Context = 128000 unless OpenRouter supplies model
metadata, compaction on.

### Power user: provider-level override
```json
// _global.json
{
  "mcpServers": { ... },
  "providerDefaults": {
    "openai-compat": {
      "contextWindow": 65536,
      "compaction": { "reserveTokens": 8192 }
    }
  }
}
```
All `openai-compat` agents get 65536 context and 8192 reserve. Other compaction fields
still fall through to TS defaults.

### Super power user: per-agent override
```json
// <current-home>/profiles/agents/creative.json
{
  "provider": "openai-compat",
  "model": "deepseek-r1-qwen3-8b",
  "contextWindow": 16384,
  "compaction": { "enabled": false }
}
```
This specific agent gets 16384 context with compaction off, regardless of what
provider defaults or TS fallbacks say.

## Code Path

Profile and global config files are loaded by `profiles.ts`; session-level values
such as provider/model/effort are resolved by `session-manager.ts` before the
provider receives `TurnContext`.

For PI providers, model-window resolution happens in two places in
`providers/pi-agent.ts`:

1. **`buildModel()`** — resolves `contextWindow` and `maxOutputTokens` for the
   PI Model object that controls when the LLM thinks context is full.

2. **`startTurn()`** — resolves `compaction.*` for `SettingsManager.inMemory()`,
   which controls PI's automatic compaction behavior.

Model construction reads current-Vault provider defaults; compaction reads
`getGlobalConfig(session.cwd).providerDefaults?.[providerName]`, so project
`_global.json` can override compaction settings for the active workspace.
