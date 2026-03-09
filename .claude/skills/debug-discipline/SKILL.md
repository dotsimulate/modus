---
name: debug-discipline
description: >
  Enforces disciplined debugging methodology when investigating bugs, errors, or unexpected
  behavior in the harness or any codebase. Auto-triggers when the agent encounters an error,
  a failing test, a user-reported bug, or any "why is this happening" investigation. Prevents
  the #1 failure mode: theorizing about what code does instead of reading it and adding logs.
  TRIGGER on: error messages, stack traces, "not working", "broken", "bug", debugging sessions,
  "Session ID already in use", SDK errors, process crashes, unexpected UI behavior.
---

# Debug Discipline

You are debugging. Follow this protocol exactly. Do NOT skip steps.

## The Rule

**Read first. Log second. Fix third. Never theorize.**

If you have not read the code that produced the error, you do not understand it.
If you have not added a log to see actual runtime values, you are guessing.
Guessing is banned. Every guess that's wrong costs the user a turn and their patience.

## Protocol

### 1. Read the error

Read the FULL error message, stack trace, and any log output the user pasted.
Identify the exact file, line, and function where the error originates.

### 2. Read the code

Read the file(s) involved. Not summaries. Not memory. The actual current code.
If the error involves a dependency (SDK, library), read the dependency's source too.
Use `node_modules/` paths, `.d.ts` files, or bundled source — whatever is available.

Do NOT propose a fix until you have read the code that produces the error.

### 3. Add diagnostic logs

Before changing any logic, add `console.log` statements that show:
- The actual values of variables at the error site
- Which branch/path the code took
- What arguments were passed to the failing function

Tell the user to reproduce and paste the output.

### 4. Read the log output

When the user provides log output, read it carefully. The logs tell you what happened.
The fix should be obvious from the logs. If it isn't, add more logs. Do NOT theorize.

### 5. Make ONE targeted fix

Fix the specific thing the logs revealed. Not a refactor. Not a restructure.
One surgical change. Verify it worked.

## Anti-Patterns (BANNED)

- Making multiple guesses without verifying any of them
- Saying "the issue might be..." more than once without adding a log
- Proposing fixes based on what you think the code does (vs what you read it does)
- Spending more than 2 messages analyzing without producing a log or a fix
- Theorizing about race conditions, timing issues, or "maybe" scenarios without evidence
- Reading your own prior messages as a substitute for reading the actual code

## Mode: Interactive vs Autonomous

This skill runs in two modes depending on context:

**Interactive (default):** The user is present and pasting logs. Follow the protocol
as written — add logs, ask for output, iterate with the user.

**Autonomous:** The user explicitly asked you to "figure it out", "fix it", "debug this
fully", or delegated via a handoff/agent task. In this mode:
- Run the app or tests yourself (Bash tool) to capture log output directly
- Do NOT stop to ask the user for reproduction — reproduce it yourself
- Follow the same read-code → add-logs → read-output → fix cycle, but YOU run each step
- If you need to restart a server, run a request, or trigger the bug — do it
- Stay in this mode until the bug is fixed or you hit the escape hatch

Both modes follow the same discipline. The only difference is who runs the reproduction.

## Escape Hatch

If you've added logs, read the output, and still don't understand after 3 attempts:
STOP. Write a clear handoff describing what you know, what you tried, and what the
logs showed. Do NOT continue guessing. The user explicitly prefers a handoff over
circular debugging.
