---
title: Skills
lastUpdated: 2026-07-26
covers: harness/skills.ts harness/skill-attachment.ts harness/modus-mcp.ts harness/providers/provider-names.ts
audience: user
---

# Skills

A skill is packaged text an agent loads when it needs it: a directory with a
`SKILL.md` file, optionally pointing at further files the agent reads on its own.

Modus is aware of skills. It does not own them. The format here is deliberately
the same one Claude-family CLIs and PI already read, because that is the entire
point — a move can never leave the building, a skill can.

**Modus does not touch your existing `.claude/skills/` or `.pi/skills/`.** It
never scans them, copies into them, symlinks, or disables your provider's own
discovery. Whatever you have keeps working exactly as it does today. Modus
skills are additive.

## What a skill is not

A skill is not a move. Moves are a harness-enforced protocol: typed ops,
server-held state, widgets, validation, a referee. A skill is text with no
enforcement, no state, and no widget. If you need the harness to check
something, you want a move. If you need knowledge that travels, you want a skill.

## Where skills go

```
<project>/.modus/skills/<name>/SKILL.md     project-scoped
~/.modus/skills/<name>/SKILL.md             every project on this machine
<plugin>/.modus/skills/<name>/SKILL.md      shipped by a plugin
<move>/skills/<name>/SKILL.md               bundled inside a move
```

On a name collision the most specific wins: project, then user, then plugin.
Shadowed copies are reported in the backend log. Nothing is ever copied — files
are read where they live.

`SKILL.md` carries YAML front-matter with at least `name` and `description`:

```markdown
---
name: render-pipeline
description: >
  How this project's render pipeline is wired, and the order operations must
  run in. Use when touching anything under render/.
---

# Render pipeline

...

See `references/troubleshooting.md` for failure modes.
```

The directory name is canonical — a `name:` in front-matter that disagrees is
ignored. Other keys (`allowed-tools` and the like) are preserved untouched, so
the file stays portable to other tooling.

## Installed is not available

Putting a skill on disk does not give any agent access to it. Something must
**attach** it:

| Attach point | Field | Effect |
|---|---|---|
| Agent profile | `skills: ["name", …]` | attached for the whole session |
| Move | `skills: [...]` in `move.json` | attached while the move is active |
| Action | `skills: [...]` in `action.json` | attached to the spawned session |
| Move bundle | files at `<move>/skills/` | attached whenever that move is |

Attachment composes: profiles and actions already attach moves, so a move that
bundles skills carries them wherever it is attached. That also gives a move an
exportable part — the protocol stays Modus-only, the knowledge travels.

A name that resolves to nothing is logged and skipped. It never fails a session.

## How an agent gets a skill

Two paths, depending on what the provider can do. Modus picks; you do not
configure this.

**Providers that read skills natively** — Claude Code (and the PTY variant) read
`<cwd>/.claude/skills/`; PI reads `.pi/skills/`. PI additionally accepts extra
skill files at startup, so Modus hands it the attached `SKILL.md` paths directly
and PI loads them the way it loads its own. Nothing is copied. Your own skills
are passed first, so on a name collision yours wins.

**Every other provider** — codex, cursor, antigravity, grok-build and the rest
read no skills at all. For those, a session with attached skills gets two extra
tools on the Modus MCP endpoint:

```
skills_list          → [{ name, description }] for attached skills
skills_load { name } → the activation payload (see below)
```

That is progressive disclosure: the listing is cheap, the body is only paid for
when wanted.

## The activation payload

However a skill reaches an agent — `skills_load`, or staged on the composer —
it arrives in the shape the [Agent Skills standard](https://agentskills.io/specification)
established and Claude Code implements:

```
Base Path: /path/to/.modus/skills/my-skill

# My Skill
…body…
```

Two rules, both load-bearing:

- **Frontmatter is stripped.** `name` and `description` exist so a picker can
  *select* the skill. Replaying them after selection is noise, and their
  "use when…" phrasing reads as a contradictory instruction to an agent that is
  already holding the skill.
- **The base path leads.** The standard tells authors to reference bundled files
  relative to the skill root (`references/REFERENCE.md`), which is unresolvable
  unless the agent is told that root. Without it, every multi-file skill
  silently degrades to its top-level page.

`${CLAUDE_SKILL_DIR}` and `${SKILL_DIR}` are substituted in the body with the
skill's absolute directory, so a skill written for another harness works here
unchanged.

The raw file, frontmatter included, is still what the picker's preview shows and
what the file API serves — only the *activation* payload is normalized.

**When nothing is attached, those tools are not registered at all.** No tool
surface, no prompt cost, no behavior change for anyone who never opts in.

Because a provider receives its endpoint URL when it starts, skills attached
mid-session (by activating a move after the fact) are recorded but may not
reach the agent by tool until the session restarts. Picking the skill from the
composer works regardless.

## Invoking a skill yourself

Type `/` in the composer. Skills appear in the same dropdown as moves and
prompts.

- A **native** skill inserts `/name` and lets the provider load it, exactly as
  it would outside Modus. Listed only when the current provider actually reads
  native skills.
- A **Modus** skill inserts the full `SKILL.md` text, because no provider will
  resolve `/name` for it — the harness is the loader. You asking for it is the
  decision to load it.

## Plugins that ship skills

A skill is instructions placed in an agent's context, so a plugin shipping one
ships *behavior*, not just capability. Skills a plugin provides are listed on
its entry in the extensions panel. Read them before enabling a plugin from a
source you do not control.

## Provider reality

| Provider | Reads its own skills | Modus can hand it skills |
|---|---|---|
| claude-code, claude-code-pty | yes (`.claude/skills/`) | no — uses the skill tools |
| litellm, ollama, openrouter (PI) | yes (`.pi/skills/`) | yes, natively |
| codex, cursor, antigravity, grok-build, opencode, gemini-cli | no | no — uses the skill tools |

The tool path depends on the provider mounting the built-in `modus` MCP server,
which is the same thing moves depend on.
