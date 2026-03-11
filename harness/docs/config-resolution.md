---
title: Config Resolution
audience: agents
lastUpdated: 2026-03-11
lastCommit: cf9d454
covers: harness/config-resolver.ts harness/profiles/
---

# Config Resolution

Every runtime value in the harness resolves through a layered chain. The first
non-undefined value wins. No layer is required — the system works with zero config.

## Resolution Order

```
profile JSON  →  _global.json providerDefaults  →  TypeScript fallback
(per-agent)      (per-provider, all agents)         (hardcoded, invisible)
```

**Profile JSON** (`profiles/agents/<name>.json`): Per-agent overrides. A creative
agent might want a smaller context window to force earlier compaction. A coding agent
might want compaction disabled entirely.

**Provider Defaults** (`profiles/_global.json` → `providerDefaults.<provider>`):
Per-provider overrides. If your llama-server runs `-c 65536`, set it once here and
every litellm agent inherits it. Optional — most users never touch this.

**TypeScript fallback** (in `pi-agent.ts`): Ships with sane defaults. 32768 context,
2048 max output, compaction enabled with 16384 reserve and 20000 keep-recent.

## What's Configurable

| Field | Profile | Provider Default | TS Fallback | Notes |
|-------|---------|-----------------|-------------|-------|
| `contextWindow` | ✓ | ✓ | 32768 | Must match your inference server's `-c` flag for local models |
| `maxOutputTokens` | ✓ | ✓ | 2048 | Max tokens per response |
| `compaction.enabled` | ✓ | ✓ | true | Threshold compaction at ~75% context usage |
| `compaction.reserveTokens` | ✓ | ✓ | 16384 | Tokens reserved for the next response |
| `compaction.keepRecentTokens` | ✓ | ✓ | 20000 | Recent context preserved during compaction |

## Examples

### Zero config (just works)
```json
{
  "provider": "litellm",
  "model": "glm-4.7-flash",
  "prompt": "You are a coding assistant."
}
```
Uses all TypeScript defaults. Context = 32768, compaction on.

### Power user: provider-level override
```json
// _global.json
{
  "mcpServers": { ... },
  "providerDefaults": {
    "litellm": {
      "contextWindow": 65536,
      "compaction": { "reserveTokens": 8192 }
    }
  }
}
```
All litellm agents get 65536 context and 8192 reserve. Other compaction fields
still fall through to TS defaults.

### Super power user: per-agent override
```json
// profiles/agents/creative.json
{
  "provider": "litellm",
  "model": "deepseek-r1-qwen3-8b",
  "contextWindow": 16384,
  "compaction": { "enabled": false }
}
```
This specific agent gets 16384 context with compaction off, regardless of what
provider defaults or TS fallbacks say.

## Code Path

Resolution happens in two places in `providers/pi-agent.ts`:

1. **`buildModel()`** — resolves `contextWindow` and `maxOutputTokens` for the
   PI Model object that controls when the LLM thinks context is full.

2. **`startTurn()`** — resolves `compaction.*` for `SettingsManager.inMemory()`,
   which controls PI's automatic compaction behavior.

Both read `getGlobalConfig().providerDefaults?.[providerName]` as the middle tier.
