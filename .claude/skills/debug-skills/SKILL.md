---
name: debug-skills
description: Meta-diagnostic skill for reviewing, validating, and troubleshooting the memory and skill system. Invoke only when the user detects issues with skills, memories, or when agent behavior seems influenced by incorrect stored information.
disable-model-invocation: true
---

# Debug Skills & Memory System

You are entering diagnostic mode. Proceed with heightened caution — this mode involves reviewing and potentially modifying the information that shapes your behavior across sessions.

## Step 1 — System Audit

1. Use `memory_stats` to get a full overview of the memory store
2. Use `list_skills` to enumerate all available skills
3. Use `list_memories` to show the full memory inventory
4. Present this overview to the user before proceeding

## Step 2 — User-Guided Investigation

Ask the user what issue they've noticed. Common scenarios:

| Symptom | Investigation |
|---------|--------------|
| "You keep doing X wrong" | Search memories for conflicting entries about X |
| "You're ignoring a skill" | Verify the skill exists, check description clarity |
| "You have a bad memory" | Search and identify the problematic entry |
| "Skills seem outdated" | Cross-reference skill content against recent memories |
| "You're being too cautious/bold about Y" | Look for hazard or preference memories affecting Y |

## Step 3 — Diagnosis

Based on the user's report:

1. Search memories AND skills related to the reported issue
2. Present **ALL** related entries to the user — do not filter or hide anything
3. Identify potential conflicts, stale information, or incorrect entries
4. Explain your assessment clearly

## Step 4 — Remediation

**Every change requires explicit user approval.** Present proposed changes one at a time.

For each proposed change, show:
- The current content
- The proposed modification
- Why you think this change is needed

Available actions:
- **Update a memory**: Use `update_memory` to correct content, adjust confidence, or fix tags
- **Remove a memory**: Use `forget` to delete incorrect entries
- **Flag a skill for editing**: Tell the user which SKILL.md file needs changes and what should change. Provide the file path. Do NOT edit SKILL.md files directly in this mode.

## Step 5 — Verification

After changes are made:
1. Run `memory_stats` again to confirm the store is in good shape
2. Search for the topic that was problematic to verify the fix
3. Suggest the user test the corrected behavior in a normal session

## Rules for This Mode

- **One change at a time.** Never batch changes. Present, confirm, execute, repeat.
- **Never auto-edit skills.** Skills are user-authored. You can suggest changes but the user must make them (or explicitly instruct you to).
- **Never delete memories without showing them first.** The user must see what they're removing.
- **If uncertain, ask.** This mode is for careful investigation, not quick fixes.
- **Do not create new memories or skills in this mode.** This is purely diagnostic and corrective.
