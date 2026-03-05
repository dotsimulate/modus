#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["fastmcp>=2.0.0"]
# ///
"""
Agent Memory — MCP Server

Single-tool MCP server for agent memory recall and skill discovery.
Memories are markdown files in a directory. Skills are scanned from
.claude/skills/ directories. One tool queries both.

Usage:
    uv run server.py
    uv run server.py --memory-dir ./memory --skills-dir ../.claude/skills
"""

import argparse
import os
import re
from pathlib import Path

from fastmcp import FastMCP

# ── Configuration ────────────────────────────────────────────────────


def resolve_config():
    parser = argparse.ArgumentParser(description="Agent Memory MCP Server")
    parser.add_argument(
        "--memory-dir",
        default=os.environ.get(
            "AGENT_MEMORY_DIR",
            str(Path(__file__).parent / "memory"),
        ),
    )
    parser.add_argument(
        "--read-dir",
        action="append",
        default=None,
        help="Additional read-only memory directories (repeatable)",
    )
    parser.add_argument(
        "--skills-dir",
        action="append",
        default=None,
    )
    args = parser.parse_args()

    # Read-only dirs: CLI args, then env var, then empty
    read_dirs = args.read_dir or []
    if not read_dirs:
        env_read = os.environ.get("AGENT_MEMORY_READ_DIRS", "")
        if env_read:
            read_dirs = [d.strip() for d in env_read.split(",") if d.strip()]

    skills_dirs = args.skills_dir
    if not skills_dirs:
        env_dirs = os.environ.get("AGENT_MEMORY_SKILLS_DIRS", "")
        if env_dirs:
            skills_dirs = [d.strip() for d in env_dirs.split(",") if d.strip()]
        else:
            default = Path(__file__).parent.parent / ".claude" / "skills"
            skills_dirs = [str(default)] if default.exists() else []

    return args.memory_dir, read_dirs, skills_dirs


MEMORY_DIR, READ_DIRS, SKILLS_DIRS = resolve_config()
Path(MEMORY_DIR).mkdir(parents=True, exist_ok=True)

mcp = FastMCP("Agent Memory")


# ── File helpers ─────────────────────────────────────────────────────


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("---", 3)
    if end == -1:
        return {}, text
    meta = {}
    for line in text[3:end].strip().splitlines():
        sep = line.find(":")
        if sep == -1:
            continue
        key = line[:sep].strip()
        val = line[sep + 1 :].strip().strip("\"'")
        # Parse YAML-ish lists: [a, b, c]
        if val.startswith("[") and val.endswith("]"):
            val = [v.strip().strip("\"'") for v in val[1:-1].split(",") if v.strip()]
        meta[key] = val
    return meta, text[end + 3 :].strip()


def read_memory(path: Path) -> dict | None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    meta, body = parse_frontmatter(text)
    priority_raw = meta.get("priority", "0")
    try:
        priority = int(priority_raw)
    except (ValueError, TypeError):
        priority = 0

    return {
        "id": path.stem,
        "type": meta.get("type", ""),
        "tags": meta.get("tags", []),
        "confidence": meta.get("confidence", ""),
        "created": meta.get("created", ""),
        "profile": meta.get("profile", None),
        "priority": priority,
        "content": body,
    }


def read_skill(skill_dir: Path) -> dict | None:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return None
    try:
        text = skill_md.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    meta, _ = parse_frontmatter(text)
    return {
        "name": meta.get("name", skill_dir.name),
        "description": meta.get("description", ""),
        "invocable": meta.get("disable-model-invocation", "false").lower() != "true",
    }


def keyword_score(text: str, terms: list[str]) -> int:
    text_lower = text.lower()
    return sum(1 for t in terms if t in text_lower)


# ── Tools ────────────────────────────────────────────────────────────


@mcp.tool()
def save(id: str, content: str, type: str = "discovery", tags: str = "", confidence: str = "medium", priority: int = -1) -> str:
    """Save a memory to the store.

    Use this whenever you learn something worth persisting across sessions —
    corrections from the user, discovered patterns, research findings, or
    anything you'd want to recall later.

    The memory is written as a markdown file with frontmatter. Use a
    descriptive kebab-case ID (e.g. "claude-code-tool-filtering" not
    "memory-001"). If a memory with this ID already exists, it will be
    overwritten — use this to update/refine existing memories.

    **Priority & violations:** Each memory has a priority score (default 0).
    When you violated a memory (you had the knowledge but didn't apply it),
    rewrite it with an incremented priority and add a "## Violations" section
    documenting what went wrong. Memories with higher priority sort first in
    query("*") results and are marked [!!N], making them harder to overlook.
    If you don't pass priority, the existing value is preserved on overwrites.

    Args:
        id: Kebab-case identifier for the memory (becomes the filename).
        content: The body of the memory — markdown text with what you learned.
        type: Category — one of: correction, discovery, pattern, preference, reference
        tags: Comma-separated tags for search (e.g. "cli, tools, permissions")
        confidence: How solid this is — high, medium, or low
        priority: Violation priority (0 = normal). Increment when recording a violation. Omit to preserve existing value.
    """
    from datetime import datetime, timezone

    memory_dir = Path(MEMORY_DIR)
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []
    tags_yaml = "[" + ", ".join(tag_list) + "]" if tag_list else "[]"

    profile = os.environ.get("AGENT_PROFILE", "")
    profile_line = f"profile: {profile}\n" if profile else ""

    # If priority not explicitly set, preserve existing value
    if priority < 0:
        existing_path = memory_dir / f"{id}.md"
        if existing_path.exists():
            existing = read_memory(existing_path)
            priority = existing.get("priority", 0) if existing else 0
        else:
            priority = 0

    text = (
        f"---\n"
        f"type: {type}\n"
        f"tags: {tags_yaml}\n"
        f"confidence: {confidence}\n"
        f"created: {datetime.now(timezone.utc).isoformat()}\n"
        f"priority: {priority}\n"
        f"{profile_line}"
        f"---\n\n"
        f"{content}\n"
    )

    path = memory_dir / f"{id}.md"
    path.write_text(text, encoding="utf-8")
    return f"Saved memory '{id}' (priority: {priority}) to {path.name}"


# ── Query tool ───────────────────────────────────────────────────────


@mcp.tool()
def query(input: str) -> str:
    """Query your memories and skills.

    This is your interface to everything you've learned in past sessions
    and all available skills. Use it freely — before unfamiliar tasks,
    when the user references past work, or when you sense you've solved
    something similar before.

    Input modes:
      - Search:  query("feedback TOP wiring")  → keyword search across all memories and skills
      - Recall:  query("glsl-output-swizzle")  → full content of a specific memory by ID
      - List:    query("*")                    → everything in the store

    **Priority ranking:** Memories with violations are marked [!!N] and sorted
    to the top of query("*") results. These are memories you've had before but
    failed to apply — pay extra attention to them. In keyword search, priority
    is used as a tiebreaker between equally relevant results.

    Memories were created during past session reflections (/session-reflect).
    If you learn something new this session that should be remembered, suggest
    running /session-reflect to the user — it will guide you through persisting
    what you've learned.

    Skills are invocable patterns. If a skill matches your query, you can
    invoke it with the Skill tool or the user can type /skill-name.

    Args:
        input: A search query, a specific memory ID, or "*" to list all.
    """
    memory_dir = Path(MEMORY_DIR)
    input = input.strip()

    # All memory directories: primary first, then read-only dirs
    all_memory_dirs = [memory_dir] + [Path(d) for d in READ_DIRS]

    # ── Exact recall by ID ───────────────────────────────────────
    for d in all_memory_dirs:
        exact_path = d / f"{input}.md"
        if exact_path.exists():
            mem = read_memory(exact_path)
            if mem:
                tags = ", ".join(mem["tags"]) if isinstance(mem["tags"], list) else mem["tags"]
                pri = mem.get("priority", 0)
                pri_str = f"  |  **Priority:** {pri}" if pri > 0 else ""
                return (
                    f"## Memory: {mem['id']}\n"
                    f"**Type:** {mem['type']}  |  "
                    f"**Confidence:** {mem['confidence']}  |  "
                    f"**Tags:** {tags}  |  "
                    f"**Created:** {mem['created']}{pri_str}\n\n"
                    f"{mem['content']}"
                )

    # ── Gather all memories (primary wins on ID conflict) ────────
    memories_by_id: dict[str, dict] = {}
    for d in all_memory_dirs:
        if not d.exists():
            continue
        for f in sorted(d.glob("*.md")):
            mem = read_memory(f)
            if mem and mem["id"] not in memories_by_id:
                memories_by_id[mem["id"]] = mem
    memories = list(memories_by_id.values())

    # ── Gather all skills ────────────────────────────────────────
    skills = []
    for sd in SKILLS_DIRS:
        sp = Path(sd)
        if not sp.exists():
            continue
        for entry in sorted(sp.iterdir()):
            if entry.is_dir():
                sk = read_skill(entry)
                if sk:
                    skills.append(sk)

    # ── List all ─────────────────────────────────────────────────
    if input == "*":
        lines = []
        if memories:
            # Sort by priority descending so violated memories surface first
            memories.sort(key=lambda m: m.get("priority", 0), reverse=True)
            lines.append(f"## Memories ({len(memories)})\n")
            for m in memories:
                tags = ", ".join(m["tags"]) if isinstance(m["tags"], list) else m["tags"]
                pri = m.get("priority", 0)
                pri_marker = f" [!!{pri}]" if pri > 0 else ""
                lines.append(
                    f"- **{m['id']}** [{m['type']}]{pri_marker} {m['content'][:80]}..."
                    + (f" _({tags})_" if tags else "")
                )
        else:
            lines.append("## Memories\nNone stored yet.\n")

        if skills:
            lines.append(f"\n## Skills ({len(skills)})\n")
            for s in skills:
                invoke = f"`/{s['name']}`" if s["invocable"] else "(auto-only)"
                lines.append(f"- **{s['name']}** {invoke}: {s['description'][:100]}")

        return "\n".join(lines)

    # ── Keyword search ───────────────────────────────────────────
    terms = [t.lower() for t in input.split() if len(t) > 1]
    if not terms:
        return "Empty query. Pass a search term, a memory ID, or * to list all."

    scored_memories = []
    for m in memories:
        searchable = f"{m['id']} {m['type']} {m['content']} {m.get('tags', '')}"
        score = keyword_score(searchable, terms)
        if score > 0:
            scored_memories.append((score, m))
    scored_memories.sort(key=lambda x: (x[0], x[1].get("priority", 0)), reverse=True)

    scored_skills = []
    for s in skills:
        searchable = f"{s['name']} {s['description']}"
        score = keyword_score(searchable, terms)
        if score > 0:
            scored_skills.append((score, s))
    scored_skills.sort(key=lambda x: x[0], reverse=True)

    lines = []

    if scored_memories:
        lines.append(f"## Memories ({len(scored_memories)} matches)\n")
        for _, m in scored_memories[:10]:
            tags = ", ".join(m["tags"]) if isinstance(m["tags"], list) else m["tags"]
            pri = m.get("priority", 0)
            pri_marker = f" [!!{pri}]" if pri > 0 else ""
            lines.append(
                f"- **{m['id']}** [{m['type']}]{pri_marker} (conf: {m['confidence']})\n"
                f"  {m['content'][:120]}\n"
                f"  _Tags: {tags}_  —  "
                f"_Full recall:_ `query(\"{m['id']}\")`"
            )
    else:
        lines.append("## Memories\nNo matches.\n")

    if scored_skills:
        lines.append(f"\n## Skills ({len(scored_skills)} matches)\n")
        lines.append(
            "_To invoke a skill, use the Skill tool or the user types `/skill-name`._\n"
        )
        for _, s in scored_skills[:5]:
            invoke = f"`/{s['name']}`" if s["invocable"] else "(auto-only)"
            lines.append(f"- **{s['name']}** {invoke}: {s['description'][:100]}")
    else:
        lines.append("\n## Skills\nNo matches.\n")

    return "\n".join(lines)


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
